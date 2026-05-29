import { execSync } from "node:child_process";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../version.js";
import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchSplit,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchEmbeddingMode,
  type BenchTokenMetrics
} from "../harness/daemon.js";
import { aggregateBenchTokenMetrics } from "./token-economy.js";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "./recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "./diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./diagnostics-artifacts.js";
import {
  isAbstentionQuestionId,
  scoreAbstentionQuestion
} from "./abstention.js";
import { pairSessionIntoRounds, type LongMemEvalVariant } from "./dataset.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  type LongMemEvalSidecarEntry
} from "./runner.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  createCompileSeedRunner,
  resolveBenchAllowLiveExtraction,
  toSeedExtractionPathKpi,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "./compile-seed.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "./seed-extraction-release-blocker.js";

const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";

export interface LongMemEvalMultiturnRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  readonly rounds?: number;
}

export interface LongMemEvalMultiturnRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

type SidecarEntry = LongMemEvalSidecarEntry;

interface RoundResult {
  readonly roundIndex: number;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  // Phase 7 per-recall token-economy sample for this round; null when the
  // degraded recall path (any non-null degradation_reason) omits the
  // token_economy block in core, so the bench extractor returns null and
  // degraded rounds don't dilute the run-level distribution.
  // see also: packages/core/src/recall-service.ts
  // (computeRecallTokenEconomy call site).
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
}

interface QuestionResult {
  readonly questionId: string;
  readonly rounds: readonly RoundResult[];
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly tokenMetrics: BenchTokenMetrics;
}

export async function runLongMemEvalMultiturn(
  opts: LongMemEvalMultiturnRunOptions
): Promise<LongMemEvalMultiturnRunResult> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);
  const rounds = Math.max(1, opts.rounds ?? 3);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled"
  );

  async function runOneQuestion(
    question: typeof window[number],
    seedRunner: CompileSeedRunner
  ): Promise<QuestionResult> {
    const daemon = await startBenchDaemon({
      workspaceId: `lme-mt-${question.question_id.slice(0, 8)}`,
      runId: `run-mt-${question.question_id.slice(0, 8)}`,
      embeddingMode: opts.embeddingMode ?? "disabled"
    });
    try {
      const sidecar = new Map<string, SidecarEntry>();
      const answerSessionSet = new Set(question.answer_session_ids);
      let seedTurnsTruncated = 0;
      let answerTurnsTruncated = 0;
      let seedCharsClipped = 0;
      // see also: apps/bench-runner/src/harness/seed-rotation.ts
      let seedIndexMt = 0;

      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `session-${si}`;
        if (session === undefined) continue;

        // invariant: extract per ROUND (user message + assistant response),
        // not per bare message — production POST_TURN_EXTRACT extracts per
        // round. see also: apps/bench-runner/src/longmemeval/dataset.ts
        // pairSessionIntoRounds.
        const rounds = pairSessionIntoRounds(session);
        // Per-session turns collected for the L2 synthesis seed below.
        const sessionTurns: SessionSeededTurn[] = [];
        let sessionHasAnswer = false;
        // see also: longmemeval/runner.ts session-adjacent derives_from anchor
        let previousTurnSeedMemoryIds: readonly string[] = [];
        for (let ri = 0; ri < rounds.length; ri++) {
          const round = rounds[ri];
          if (round === undefined) continue;

          const evidenceRef = `${question.question_id}-mt-s${si}-r${ri}`;
          const seedResult = await seedRunner.seedTurn({
            daemon,
            turnContent: round.content,
            evidenceRefBase: evidenceRef,
            seedIndex: seedIndexMt,
            workspaceId: daemon.workspaceId,
            runId: daemon.runId,
            ...(previousTurnSeedMemoryIds.length === 0
              ? {}
              : { sourceMemoryRefs: previousTurnSeedMemoryIds })
          });
          seedIndexMt += 1;
          if (seedResult.turnTruncated) {
            seedTurnsTruncated += 1;
            seedCharsClipped += seedResult.charsClipped;
            if (round.hasAnswer) {
              answerTurnsTruncated += 1;
            }
          }
          if (round.hasAnswer) {
            sessionHasAnswer = true;
          }
          for (const seed of seedResult.seeds) {
            sidecar.set(buildLongMemEvalSidecarKey("memory_entry", seed.memoryId), {
              objectId: seed.memoryId,
              objectKind: "memory_entry",
              sessionId,
              hasAnswer: round.hasAnswer
            });
            sessionTurns.push({
              turnContent: round.content,
              evidenceId: seed.evidenceId
            });
          }
          // invariant: single-id D-1 fan-out. see also:
          //   apps/bench-runner/src/longmemeval/compile-seed.ts computeNextTurnSeedRefs
          previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
        }

        // L2 synthesis seed — see runner.ts for the rationale. The synthesis
        // object_id is sidecar-tracked for diagnostics but does not enter
        // memory_entry gold scoring.
        const synthesisInput = buildSessionSynthesisInput({
          topicKey: `${question.question_id}-mt-s${si}`,
          turns: sessionTurns
        });
        if (synthesisInput !== null) {
          const synthesisResult = await daemon.proposeSynthesis(synthesisInput);
          if (synthesisResult.synthesisId !== null) {
            sidecar.set(buildLongMemEvalSidecarKey("synthesis_capsule", synthesisResult.synthesisId), {
              objectId: synthesisResult.synthesisId,
              objectKind: "synthesis_capsule",
              sessionId,
              hasAnswer: sessionHasAnswer
            });
          }
        }
      }

      if (opts.embeddingMode === "env") {
        await daemon.runtime.runGardenBackgroundPass();
      }

      const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);
      const roundResults: RoundResult[] = [];

      for (let roundIndex = 1; roundIndex <= rounds; roundIndex++) {
        const recallStart = Date.now();
        const recallResult = await daemon.recall(question.question, {
          maxResults: 10
        });
        const latencyMs = Date.now() - recallStart;
        const results = recallResult.results;
        const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
          object_id: pointer.object_id,
          object_kind: pointer.object_kind,
          rank: index + 1,
          relevance_score: pointer.relevance_score,
          score_factors: pointer.score_factors ?? null
        }));

        let hitAt1 = false;
        let hitAt5 = false;
        let hitAt10 = false;
        let firstTier: "hot" | "warm" | "cold" = "cold";
        const usedGoldObjectIds: string[] = [];

        for (let rank = 0; rank < results.length && rank < 10; rank++) {
          const pointer = results[rank];
          if (pointer === undefined) continue;
          if (rank === 0) {
            firstTier = inferTier(pointer.relevance_score);
          }
          if (!isLongMemEvalGoldEligibleResult(pointer)) {
            continue;
          }
          const meta = sidecar.get(buildLongMemEvalSidecarKey("memory_entry", pointer.object_id));
          const isHit =
            meta !== undefined &&
            meta.hasAnswer &&
            answerSessionSet.has(meta.sessionId);
          if (isHit) {
            usedGoldObjectIds.push(pointer.object_id);
            if (rank === 0) hitAt1 = true;
            if (rank < 5) hitAt5 = true;
            hitAt10 = true;
          }
        }

        // Abstention questions never produce an id-equality hit; re-score
        // them by calibrated confidence so the recall@k numerator stays
        // consistent with the single-turn runner. invariant: only
        // hit_at_k is overridden — firstTier is kept from the id-equality
        // loop above, which derives it from the top-1 relevance_score for
        // every row regardless of hit, so that loop must keep running for
        // `_abs` rows.
        const isAbstention = isAbstentionQuestionId(question.question_id);
        if (isAbstention) {
          const abstention = scoreAbstentionQuestion({ results });
          hitAt1 = abstention.correctAt1;
          hitAt5 = abstention.correctAt5;
          hitAt10 = abstention.correctAt10;
        }

        const diagnostics = buildQuestionDiagnostic({
          questionId: question.question_id,
          roundIndex,
          goldMemoryIds,
          answerSessionIds: question.answer_session_ids,
          deliveredResults,
          hitAt1,
          hitAt5,
          hitAt10,
          isAbstention,
          degradationReason: recallResult.degradation_reason ?? null,
          recallResult,
          embeddingMode: opts.embeddingMode ?? "disabled"
        });

        await daemon.reportContextUsage({
          deliveryId: recallResult.delivery_id,
          usageState: usedGoldObjectIds.length > 0 ? "used" : "skipped",
          ...(usedGoldObjectIds.length === 0
            ? {}
            : { usedObjectIds: usedGoldObjectIds }),
          deliveredObjects: results.slice(0, 10).map((pointer) => ({
            objectId: pointer.object_id,
            objectKind: pointer.object_kind ?? "memory_entry",
            usageStatus:
              isLongMemEvalGoldEligibleResult(pointer) &&
              usedGoldObjectIds.includes(pointer.object_id)
              ? "used"
              : "skipped"
          })),
          turnIndex: roundIndex,
          turnDigest: {
            lastMessages: [
              {
                role: "user",
                contentExcerpt: truncateExcerpt(question.question)
              }
            ]
          },
          reason:
            usedGoldObjectIds.length > 0
              ? `LongMemEval multi-turn round ${roundIndex}: gold pointer delivered.`
              : `LongMemEval multi-turn round ${roundIndex}: gold pointer not delivered.`
        });

        roundResults.push({
          roundIndex,
          hitAt1,
          hitAt5,
          hitAt10,
          firstTier,
          latencyMs,
          degradationReason: recallResult.degradation_reason ?? null,
          diagnostics,
          recallTokenEconomy: extractRecallTokenEconomy(recallResult)
        });
      }

      // Event-sourced token economy for this question's run; read back
      // from the EventLog after every round's recall, before shutdown.
      const tokenMetrics = await daemon.queryTokenMetrics();

      return {
        questionId: question.question_id,
        rounds: roundResults,
        seedTurnsTruncated,
        answerTurnsTruncated,
        seedCharsClipped,
        tokenMetrics
      };
    } finally {
      await daemon.shutdown();
    }
  }

  // invariant: one seed runner for the whole run so the on-disk extraction
  // cache and stats accumulate across questions; seed-time only.
  // createCompileSeedRunner() runs the ~1s run-start fail-loud cache preflight
  // (model / prompt-sha / coverage); a mismatch throws here instead of a 466h
  // silent live run.
  // see also: apps/bench-runner/src/longmemeval/compile-seed.ts
  //   preflightExtractionCache
  const seedRunner = createCompileSeedRunner(
    resolveBenchAllowLiveExtraction()
      ? { allowLiveExtraction: true }
      : undefined
  );
  const collected: QuestionResult[] = [];
  for (let i = 0; i < window.length; i++) {
    const q = window[i];
    if (q === undefined) continue;
    const res = await runOneQuestion(q, seedRunner);
    collected.push(res);
    const finalRound = res.rounds[res.rounds.length - 1];
    process.stdout.write(
      `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
        `rounds=${rounds} final_R@5=${finalRound?.hitAt5 ? "✓" : "✗"}\n`
    );
  }
  // Disclose which seed path ran: official_api_compile (production garden
  // extraction) vs no_credentials_fallback (degraded full-turn single-fact).
  process.stdout.write(
    `[longmemeval compile-seed] path=${seedRunner.stats.path} ` +
      `cache_hits=${seedRunner.stats.cacheHits} ` +
      `llm_calls=${seedRunner.stats.llmCalls} ` +
      `offline_fallbacks=${seedRunner.stats.offlineFallbacks} ` +
      `facts=${seedRunner.stats.factsProduced} ` +
      `signals_dropped=${seedRunner.stats.signalsDropped}\n`
  );

  const finalRounds = collected
    .map((result) => result.rounds[result.rounds.length - 1])
    .filter((result): result is RoundResult => result !== undefined);
  const perScenario: PerScenarioRow[] = finalRounds.map((result, index) => ({
    id: collected[index]?.questionId ?? `question-${index + 1}`,
    version: 1,
    hit_at_5: result.hitAt5,
    tier: result.firstTier
  }));
  const allDiagnostics = collected.flatMap((result) =>
    result.rounds.map((round) => round.diagnostics)
  );
  const finalDiagnostics = finalRounds.map((round) => round.diagnostics);
  const providerSummary = summarizeProviderStates(allDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(finalDiagnostics);

  const n = finalRounds.length;
  const rAt1 = ratio(finalRounds.filter((round) => round.hitAt1).length, n);
  const rAt5 = ratio(finalRounds.filter((round) => round.hitAt5).length, n);
  const rAt10 = ratio(finalRounds.filter((round) => round.hitAt10).length, n);
  const rAt5Round1 = rAt5ForRound(collected, 1);
  const rAt5Round2 = rounds >= 2 ? rAt5ForRound(collected, 2) : undefined;
  const latencyP50 = computePercentile(finalRounds.map((round) => round.latencyMs), 50);
  const latencyP95 = computePercentile(finalRounds.map((round) => round.latencyMs), 95);
  const tierDistribution = countTiers(finalRounds);
  const degradationReasons = countDegradationReasons(finalRounds);
  const truncation = {
    seed_turns_truncated: collected.reduce(
      (acc, result) => acc + result.seedTurnsTruncated,
      0
    ),
    answer_turns_truncated: collected.reduce(
      (acc, result) => acc + result.answerTurnsTruncated,
      0
    ),
    seed_chars_clipped: collected.reduce(
      (acc, result) => acc + result.seedCharsClipped,
      0
    )
  };

  const tokenEconomyInput = aggregateBenchTokenMetrics(
    collected.map((result) => result.tokenMetrics)
  );
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);
  // Phase 7: aggregate across EVERY round of every question so the
  // distribution reflects each recall call, not just the final round.
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    collected.flatMap((result) =>
      result.rounds
        .map((round) => round.recallTokenEconomy)
        .filter((sample): sample is BenchRecallTokenEconomy => sample !== null)
    )
  );

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;
  const split = variantToSplit(opts.variant);
  const payload: KpiPayload = {
    bench_name: "public-multiturn",
    split,
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: `${opts.variant}:multiturn`,
      size: datasetSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: datasetSize,
    evaluated_count: window.length,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      r_at_5_round_1: rAt5Round1,
      ...(rAt5Round2 === undefined ? {} : { r_at_5_round_2: rAt5Round2 }),
      r_at_5_round_n: rAt5,
      multiturn_rounds: rounds,
      ...(opts.embeddingMode === "env"
        ? {
            r_at_5_overall: rAt5,
            ...(rAt5EmbeddingReturned === undefined
              ? {}
              : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
            provider_returned_rate: providerSummary.provider_returned_rate,
            provider_pending_rate: providerSummary.provider_pending_rate,
            provider_failed_rate: providerSummary.provider_failed_rate
          }
        : {}),
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: tokenSavedRatio,
      token_economy: tokenEconomy,
      ...(recallTokenEconomy === null
        ? {}
        : { recall_token_economy: recallTokenEconomy }),
      tier_distribution: tierDistribution,
      degradation_reasons: degradationReasons,
      seed_truncation: truncation,
      seed_extraction_path: toSeedExtractionPathKpi(seedRunner.stats),
      // invariant: quality_metrics scores the final-round diagnostics so the
      // per-plane coverage denominator matches the headline r_at_5.
      quality_metrics: buildLongMemEvalQualityMetrics(finalDiagnostics),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public-multiturn", {
    split: payload.split,
    embeddingProvider: payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(runAt, commitSha7);
  const report = appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
  const findings = appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
  const diagnosticsPayload = {
    schema_version: 1,
    bench_name: "public-multiturn",
    split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: opts.embeddingMode ?? "disabled",
    provider_state_summary: providerSummary,
    questions: allDiagnostics.length > 0 ? allDiagnostics : finalDiagnostics
  } as const;
  const diagnosticsSidecar = renderDiagnosticsSidecar(diagnosticsPayload);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: opts.historyRoot,
    benchName: "public-multiturn",
    slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: diagnosticsSidecar
  });
  const compactDiagnosticsSidecar = renderCompactDiagnosticsSidecar(
    diagnosticsPayload,
    diagnosticsArtifactPath
  );

  const entry = await writeEntry(
    layout,
    "public-multiturn",
    slug,
    payload,
    report,
    findings,
    {
      sidecars: [
        {
          filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
          contents: compactDiagnosticsSidecar
        }
      ]
    }
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

function variantToSplit(variant: LongMemEvalVariant): BenchSplit {
  const map: Record<LongMemEvalVariant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  return map[variant];
}

function rAt5ForRound(collected: readonly QuestionResult[], roundIndex: number): number {
  const rows = collected
    .map((result) => result.rounds[roundIndex - 1])
    .filter((round): round is RoundResult => round !== undefined);
  return ratio(rows.filter((round) => round.hitAt5).length, rows.length);
}

function countTiers(rounds: readonly RoundResult[]): {
  readonly hot: number;
  readonly warm: number;
  readonly cold: number;
} {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const round of rounds) {
    if (round.firstTier === "hot") hot++;
    else if (round.firstTier === "warm") warm++;
    else cold++;
  }
  return { hot, warm, cold };
}

function countDegradationReasons(rounds: readonly RoundResult[]): {
  readonly none: number;
  readonly warm_cascade_engaged: number;
  readonly cold_cascade_engaged: number;
  readonly recall_explainability_partial: number;
} {
  let none = 0;
  let warm = 0;
  let cold = 0;
  let partial = 0;
  for (const round of rounds) {
    if (round.degradationReason === "warm_cascade_engaged") warm++;
    else if (round.degradationReason === "cold_cascade_engaged") cold++;
    else if (round.degradationReason === "recall_explainability_partial") partial++;
    else none++;
  }
  return {
    none,
    warm_cascade_engaged: warm,
    cold_cascade_engaged: cold,
    recall_explainability_partial: partial
  };
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}
