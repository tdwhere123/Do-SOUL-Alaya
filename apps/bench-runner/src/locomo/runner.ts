import {
  buildDiffVsPrevious,
  buildTokenEconomy,
  computeTokenSavedRatio,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../shared/version.js";
import { monotonicElapsedMs, monotonicNowNs } from "../shared/monotonic.js";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchEmbeddingWarmupSummary,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import { benchSessionSurfacesEnabled } from "../harness/daemon-support.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "../longmemeval/diagnostics-artifacts.js";
import { resolveBenchEmbeddingProviderLabel } from "../longmemeval/runner.js";
import {
  scoreQaQuestion,
  aggregateQaVerdicts,
  buildQaDeliverySettings,
  type QaQuestionVerdict,
  type QaDeliveredCandidate
} from "../longmemeval/qa-harness.js";
import { type QaChatFn, QaChatError } from "../longmemeval/qa-chat.js";
import { selectRelevantMemories } from "../longmemeval/qa-llm-filter.js";
import { buildQaSupportPack } from "../longmemeval/qa-support-pack.js";
import { resolveQaDeliveryBudget } from "../longmemeval/runner-question.js";
import {
  createCompileSeedRunner,
  computeNextTurnSeedRefs,
  resolveBenchAllowLiveExtraction,
  toSeedExtractionPathKpi,
  type CompileSeedRunner
} from "../longmemeval/compile-seed.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "../longmemeval/seed-extraction-release-blocker.js";
import { appendFileSync } from "node:fs";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "../longmemeval/recall-token-economy.js";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract
} from "../harness/token-economy.js";
import type { BenchTokenMetrics } from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import { extractSessions, type LocomoQa, type LocomoSample, type LocomoTurn, type LocomoVariant } from "./dataset.js";
import { loadLocomo, type LocomoFetchResult } from "./fetch.js";

const LOCOMO_SOURCE_URL = "https://github.com/snap-research/locomo/blob/main/data/locomo10.json";

export interface LocomoRunOptions {
  readonly variant: LocomoVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: LocomoFetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
  // End-to-end QA: present only with --qa. Supplies the answer-LLM/judge chat fn.
  readonly qa?: {
    readonly chat: QaChatFn;
    readonly judgeChat?: QaChatFn;
    readonly answerModel?: string;
    readonly judgeModel?: string;
  };
}

export interface LocomoRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string;
  readonly payload: KpiPayload;
}

interface LocomoEmbeddingVectorCacheSummary {
  readonly expected_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly max_pass_count: number;
}

interface LocomoQueryEmbeddingCacheSummary {
  readonly requested_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly last_error?: string;
}

export async function runLocomo(opts: LocomoRunOptions): Promise<LocomoRunResult> {
  const conversations = await loadLocomo(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : conversations.length;
  const window = conversations.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const embeddingProvider = resolveBenchEmbeddingProviderLabel(
    embeddingMode,
    process.env,
    opts.embeddingProviderKind ?? "openai"
  );

  const perScenario: PerScenarioRow[] = [];
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let totalHitAt1 = 0;
  let totalHitAt5 = 0;
  let totalHitAt10 = 0;
  let totalQa = 0;
  const conversationResults: ConversationResult[] = [];
  const seedRunner = createCompileSeedRunner({
    requiredTurnContents: collectDistinctLocomoTurnContents(window),
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });

  // @anchor locomo-daemon-per-run: one bench daemon spans the run; per-
  // conversation isolation is via daemon.attachWorkspace.
  const benchRunId = `locomo-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const daemon = await startBenchDaemon({
    workspaceId: `${benchRunId}-default`,
    runId: `${benchRunId}-default-run`,
    embeddingMode,
    ...(opts.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: opts.embeddingProviderKind })
  });
  try {
  let conversationFailures = 0;
  for (let i = 0; i < window.length; i++) {
    const conversation = window[i];
    if (conversation === undefined) continue;
    try {
    const convResult = await runOneConversation(
      daemon,
      seedRunner,
      conversation,
      opts
    );
    conversationResults.push(convResult);
    totalQa += convResult.qaCount;
    totalHitAt1 += convResult.hitAt1;
    totalHitAt5 += convResult.hitAt5;
    totalHitAt10 += convResult.hitAt10;
    tierHot += convResult.tierHot;
    tierWarm += convResult.tierWarm;
    tierCold += convResult.tierCold;
    questionDiagnostics.push(...convResult.questionDiagnostics);
    for (const latency of convResult.latencies) {
      latencies.push(latency);
    }
    perScenario.push({
      id: conversation.sample_id,
      version: 1,
      hit_at_5: convResult.qaCount > 0 && convResult.hitAt5 / convResult.qaCount >= 0.5,
      tier: convResult.tierHot >= convResult.tierWarm && convResult.tierHot >= convResult.tierCold
        ? "hot"
        : convResult.tierWarm >= convResult.tierCold
          ? "warm"
          : "cold"
    });
    process.stdout.write(
      `[${i + 1}/${window.length}] ${conversation.sample_id} ` +
        `qa=${convResult.qaCount} R@5=${(convResult.hitAt5 / Math.max(1, convResult.qaCount) * 100).toFixed(1)}%\n`
    );
    } catch (err) {
      // Resilience: skip only a transient QA-chat failure so one bad conversation
      // never aborts the run; a fail-closed invariant (e.g. incomplete embedding
      // warm cache) is re-thrown and still aborts. Remaining convs aggregate.
      if (!(err instanceof QaChatError)) throw err;
      conversationFailures += 1;
      process.stderr.write(
        `[${i + 1}/${window.length}] ${conversation.sample_id} FAILED — ` +
          `skipped: ${err.message}\n`
      );
    }
  }
  if (conversationFailures > 0) {
    process.stdout.write(
      `[locomo] ${conversationFailures}/${window.length} conversation(s) failed and were skipped.\n`
    );
  }
  } finally {
    await daemon.shutdown();
  }
  const extractionStats = seedRunner.stats;
  process.stdout.write(
    `[locomo compile-seed] path=${extractionStats.path} ` +
      `cache_hits=${extractionStats.cacheHits} ` +
      `llm_calls=${extractionStats.llmCalls} ` +
      `offline_fallbacks=${extractionStats.offlineFallbacks} ` +
      `facts=${extractionStats.factsProduced} ` +
      `signals_dropped=${extractionStats.signalsDropped}\n`
  );

  const rAt1 = totalQa === 0 ? 0 : totalHitAt1 / totalQa;
  const rAt5 = totalQa === 0 ? 0 : totalHitAt5 / totalQa;
  const rAt10 = totalQa === 0 ? 0 : totalHitAt10 / totalQa;

  // End-to-end QA aggregate (only when --qa ran). Printed for parity with the
  // longmemeval harness and persisted with delivery settings so agent-sim
  // levers are not conflated with recall-only runs.
  const allQaVerdicts = conversationResults.flatMap((result) => result.qaVerdicts);
  const qaMetrics =
    opts.qa !== undefined && allQaVerdicts.length > 0
      ? {
          ...aggregateQaVerdicts(allQaVerdicts),
          delivery_settings: buildQaDeliverySettings(),
          answer_model: opts.qa.answerModel ?? "unknown",
          judge_model: opts.qa.judgeModel ?? opts.qa.answerModel ?? "unknown"
        }
      : undefined;
  if (allQaVerdicts.length > 0) {
    process.stdout.write(
      `LoCoMo QA accuracy=${((qaMetrics?.qa_accuracy ?? 0) * 100).toFixed(1)}% ` +
        `(${qaMetrics?.qa_correct ?? 0}/${qaMetrics?.qa_total ?? 0})\n`
    );
    for (const [type, tally] of Object.entries(qaMetrics?.qa_by_type ?? {})) {
      process.stdout.write(`  ${type}: ${tally.correct}/${tally.total}\n`);
    }
    // Per raw LoCoMo category (1 single-hop / 2 temporal / 3 multi-hop /
    // 4 open-domain) — the ≥90/category view the temporal|factual split hides.
    const byCat = new Map<number, { correct: number; total: number }>();
    for (const row of conversationResults.flatMap((r) => r.qaCategoryRows)) {
      const t = byCat.get(row.category) ?? { correct: 0, total: 0 };
      t.total += 1;
      if (row.correct) t.correct += 1;
      byCat.set(row.category, t);
    }
    for (const cat of [...byCat.keys()].sort((a, b) => a - b)) {
      const t = byCat.get(cat)!;
      process.stdout.write(
        `  category ${cat}: ${t.correct}/${t.total} = ${((100 * t.correct) / t.total).toFixed(1)}%\n`
      );
    }
  }
  const providerStateSummary = summarizeProviderStates(questionDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(questionDiagnostics);
  const embeddingVectorCache = summarizeEmbeddingVectorCache(
    conversationResults.flatMap((result) =>
      result.embeddingWarmup === null ? [] : [result.embeddingWarmup]
    )
  );
  const queryEmbeddingCache = summarizeQueryEmbeddingCache(
    conversationResults.flatMap((result) =>
      result.queryEmbeddingWarmup === null ? [] : [result.queryEmbeddingWarmup]
    )
  );
  // Aggregate per-recall structural samples across every QA in every
  // conversation; one sample per recall call.
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    conversationResults.flatMap((result) => result.recallTokenEconomySamples)
  );
  // Event-sourced token economy: aggregate each conversation's EventLog fold
  // into one run total, then derive the headline saved ratio. The contract
  // gate fails closed when a seeded run emitted no full-turn marker.
  // see also: apps/bench-runner/src/harness/token-economy.ts assertBenchTokenEconomyContract
  const tokenEconomyInput = aggregateBenchTokenMetrics(
    conversationResults.map((result) => result.tokenMetrics)
  );
  assertBenchTokenEconomyContract("public-locomo", tokenEconomyInput);
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);

  const payload: KpiPayload = {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProvider,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: opts.variant,
      size: opts.fetchResult?.conversationCount ?? conversations.length,
      source: LOCOMO_SOURCE_URL
    },
    // invariant: sample_size + evaluated_count count QAs, not
    // conversations. The R@K denominator is `totalQa` (questions
    // actually scored across all conversations in the window); the
    // dataset-wide upper bound is the QA total of the full LoCoMo set.
    // see also: packages/eval/src/metrics/wilson-ci.ts (label cascade reads
    // evaluatedCount in question units).
    sample_size: resolveLocomoSampleSize(conversations),
    evaluated_count: totalQa,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      ...(rAt5EmbeddingReturned === undefined
        ? {}
        : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
      provider_returned_rate: providerStateSummary.provider_returned_rate,
      provider_pending_rate: providerStateSummary.provider_pending_rate,
      provider_failed_rate: providerStateSummary.provider_failed_rate,
      provider_not_requested_rate: providerStateSummary.provider_not_requested_rate,
      ...(embeddingVectorCache === null
        ? {}
        : {
            embedding_vector_cache_ready_rate:
              embeddingVectorCache.ready_rate
          }),
      ...(queryEmbeddingCache === null
        ? {}
        : {
            query_embedding_cache_ready_rate:
              queryEmbeddingCache.ready_rate
          }),
      latency_ms_p50: computePercentile(latencies, 50),
      latency_ms_p95: computePercentile(latencies, 95),
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: tokenSavedRatio,
      token_economy: tokenEconomy,
      seed_extraction_path: toSeedExtractionPathKpi(extractionStats),
      ...(recallTokenEconomy === null
        ? {}
        : { recall_token_economy: recallTokenEconomy }),
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: totalQa,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      ...(qaMetrics === undefined ? {} : { qa_metrics: qaMetrics }),
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public-locomo", {
    split: "locomo10",
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
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    embedding_mode: embeddingMode,
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    provider_state_summary: providerStateSummary,
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(questionDiagnostics),
    questions: questionDiagnostics
  } as const;
  const diagnosticsSidecar = renderDiagnosticsSidecar(diagnosticsPayload);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: opts.historyRoot,
    benchName: "public-locomo",
    slug,
    filename: "locomo-diagnostics.json",
    contents: diagnosticsSidecar
  });
  const compactDiagnosticsSidecar = renderCompactDiagnosticsSidecar(
    diagnosticsPayload,
    diagnosticsArtifactPath
  );
  const entry = await writeEntry(layout, "public-locomo", slug, payload, report, findings, {
    sidecars: [
      {
        filename: "locomo-diagnostics.json",
        contents: compactDiagnosticsSidecar
      }
    ]
  });
  const diagnosticsPath = entry.sidecarPaths["locomo-diagnostics.json"]!;

  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath,
    payload
  };
}

interface ConversationResult {
  readonly qaCount: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly hitAt10: number;
  readonly tierHot: number;
  readonly tierWarm: number;
  readonly tierCold: number;
  readonly latencies: readonly number[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  // One per-recall token-economy sample per QA in this conversation.
  // Degraded recalls (any non-null degradation_reason from
  // RecallService) emit no token_economy block, so the bench extractor
  // returns null and those samples are skipped (not pushed) — the
  // conversation-level array length therefore matches the number of
  // structurally-instrumented recalls, never the total recall count.
  // see also: packages/core/src/recall/recall-service.ts
  // (computeRecallTokenEconomy call site).
  readonly recallTokenEconomySamples: readonly BenchRecallTokenEconomy[];
  // Event-sourced token-economy fold for this conversation's own bench DB —
  // one per workspace, aggregated across conversations at the run level.
  readonly tokenMetrics: BenchTokenMetrics;
  readonly qaVerdicts: readonly QaQuestionVerdict[];
  readonly qaCategoryRows: readonly { category: number; correct: boolean }[];
}

async function runOneConversation(
  daemon: BenchDaemonHandle,
  seedRunner: CompileSeedRunner,
  conversation: LocomoSample,
  opts: LocomoRunOptions
): Promise<ConversationResult> {
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const workspace: BenchWorkspaceHandle = await daemon.attachWorkspace({
    workspaceId: `locomo-${conversation.sample_id}`,
    runId: `run-${conversation.sample_id}`
  });
  try {
    const diaIdByMemoryId = new Map<string, string>();
    const memoryIdsByDiaId = new Map<string, string[]>();
    // QA-only: resolve delivered recall pointers back to seeded content + the
    // session date. Populated always (cheap); consumed only when opts.qa is set.
    const contentByMemoryId = new Map<string, string>();
    const dateByMemoryId = new Map<string, string | null>();
    const sessionByMemoryId = new Map<string, string>();
    const sessions = extractSessions(conversation.conversation);
    // Best-effort "now" for temporal QA: the latest session date in the convo.
    const conversationNowDate =
      sessions.reduce<string | null>((latest, s) => s.date_time ?? latest, null) ?? "";
    // invariant: rotate the seeded object_kind across each turn so the
    // archive witnesses both MaterializationRouter branches (memory-
    // only + memory-and-claim-draft). Recall surface is unchanged
    // (memory_entry is persisted in both branches).
    // see also: apps/bench-runner/src/harness/seed-rotation.ts
    let seedIndex = 0;
    let sessionOrdinal = 0;
    for (const session of sessions) {
      const sessionSurfaceId = benchSessionSurfacesEnabled()
        ? `${conversation.sample_id}-s${sessionOrdinal}`
        : undefined;
      let previousTurnSeedMemoryIds: readonly string[] = [];
      // anchor: same-session co-recall members, seed order. see also:
      //   apps/bench-runner/src/longmemeval/runner.ts sessionMemberMemoryIds
      const sessionMemberMemoryIds: string[] = [];
      let turnOrdinal = 0;
      for (const turn of session.turns) {
        const seedContent = buildLocomoSeedContent(turn);
        // Round-labeled ref so parseEvidenceSourceChunkRef resolves sourceKey +
        // chunkIndex and source_proximity can pull neighboring turns. dia_id keeps
        // driving gold scoring via the maps below, so grading is unchanged.
        const evidenceRef = `${conversation.sample_id}-s${sessionOrdinal}-r${turnOrdinal}`;
        const seedResult = await seedRunner.seedTurn({
          daemon: workspace,
          turnContent: seedContent,
          evidenceRefBase: evidenceRef,
          seedIndex,
          workspaceId: workspace.workspaceId,
          runId: workspace.runId,
          ...(sessionSurfaceId === undefined
            ? {}
            : { surfaceId: sessionSurfaceId }),
          ...(previousTurnSeedMemoryIds.length === 0
            ? {}
            : { sourceMemoryRefs: previousTurnSeedMemoryIds })
        });
        seedIndex += 1;
        for (const seed of seedResult.seeds) {
          diaIdByMemoryId.set(seed.memoryId, turn.dia_id);
          const current = memoryIdsByDiaId.get(turn.dia_id) ?? [];
          current.push(seed.memoryId);
          memoryIdsByDiaId.set(turn.dia_id, current);
          contentByMemoryId.set(seed.memoryId, seedContent);
          dateByMemoryId.set(seed.memoryId, session.date_time);
          sessionByMemoryId.set(seed.memoryId, `${conversation.sample_id}-s${sessionOrdinal}`);
          sessionMemberMemoryIds.push(seed.memoryId);
        }
        previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
        turnOrdinal += 1;
      }
      // invariant: same-session EARNED co-recall accrual. Mirror of the
      // LongMemEval seed path so LoCoMo's graph/path plane earns the production
      // recalls-tier topology (co_recalled) through the onCoUsage counter gate.
      // The earned set is SPARSE (at most BENCH_CO_RECALL_WARMUP_PAIR_CAP per
      // session); pair selection uses session membership (seed order) only.
      // see also: apps/bench-runner/src/harness/co-recall-warmup.ts planSessionCoRecallWarmup
      await workspace.accrueSessionCoRecall(sessionMemberMemoryIds);
      sessionOrdinal += 1;
    }

    const allSeededMemoryIds = [...memoryIdsByDiaId.values()].flat();
    const embeddingWarmup =
      opts.embeddingMode === "env"
        ? await workspace.warmEmbeddingCache(allSeededMemoryIds)
        : null;
    const recallQuestions = conversation.qa.filter((qa) =>
      shouldRunLocomoRecall(qa, opts)
    );
    const queryEmbeddingWarmup =
      opts.embeddingMode === "env"
        ? await workspace.warmQueryEmbeddingCache(
            recallQuestions.map((qa) => qa.question)
          )
        : null;
    await daemon.runEdgePlanePassIfConfigured();

    let hitAt1 = 0;
    let hitAt5 = 0;
    let hitAt10 = 0;
    let tierHot = 0;
    let tierWarm = 0;
    let tierCold = 0;
    let scoredCount = 0;
    const latencies: number[] = [];
    const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
    const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];
    const qaVerdicts: QaQuestionVerdict[] = [];
    const qaCategoryRows: { category: number; correct: boolean }[] = [];

    // invariant: R@K counts every evidence-bearing QA, including answerless
    // adversarial rows. Those rows still have gold evidence for retrieval;
    // abstention only affects the optional QA judge prompt, not the retrieval
    // denominator.
    for (let qaIndex = 0; qaIndex < conversation.qa.length; qaIndex += 1) {
      const qa = conversation.qa[qaIndex];
      if (qa === undefined) {
        continue;
      }
      const questionId = buildLocomoQuestionId(conversation.sample_id, qaIndex);
      const evidenceSet = new Set(qa.evidence);
      const isAbstention = isLocomoAbstentionQa(qa);
      const retrievalScorable = hasLocomoRetrievalEvidence(qa);
      if (!retrievalScorable && opts.qa === undefined) {
        continue;
      }
      const goldMemoryIds = retrievalScorable
        ? resolveLocomoGoldMemoryIds({
            questionId,
            evidenceSet,
            memoryIdsByDiaId
          })
        : [];
      const result = await runQuestion(workspace, qa);
      let hit1 = false;
      let hit5 = false;
      let hit10 = false;
      if (retrievalScorable) {
        scoredCount += 1;
        latencies.push(result.latencyMs);
        const ranked = result.pointers
          .slice(0, 10)
          .map((pointer) => diaIdByMemoryId.get(pointer.object_id));
        hit1 = ranked[0] !== undefined && evidenceSet.has(ranked[0]);
        hit5 = ranked
          .slice(0, 5)
          .some((dia) => dia !== undefined && evidenceSet.has(dia));
        hit10 = ranked.some(
          (dia) => dia !== undefined && evidenceSet.has(dia)
        );
        if (hit1) hitAt1 += 1;
        if (hit5) hitAt5 += 1;
        if (hit10) hitAt10 += 1;
        const firstScore = result.pointers[0]?.relevance_score ?? 0;
        if (firstScore >= 0.7) tierHot += 1;
        else if (firstScore >= 0.4) tierWarm += 1;
        else tierCold += 1;
        questionDiagnostics.push(
          buildQuestionDiagnostic({
            questionId,
            goldMemoryIds,
            answerSessionIds: [...evidenceSet],
            deliveredResults: result.pointers.map((pointer, index) => ({
              object_id: pointer.object_id,
              rank: index + 1,
              relevance_score: pointer.relevance_score
            })),
            hitAt1: hit1,
            hitAt5: hit5,
            hitAt10: hit10,
            isAbstention: false,
            degradationReason: result.degradationReason,
            recallResult: result.recallResult,
            embeddingMode
          })
        );
        const tokenEconomySample = extractRecallTokenEconomy(result.recallResult);
        if (tokenEconomySample !== null) {
          recallTokenEconomySamples.push(tokenEconomySample);
        }
      }

      // End-to-end QA: answer-LLM over delivered recall + LLM-judge vs gold.
      // Gated on opts.qa so a normal run makes zero LLM calls. Category-5
      // answerless rows still count in the retrieval denominator when they
      // carry gold evidence; abstention only changes the QA judge prompt.
      if (opts.qa !== undefined) {
        const widePool: QaDeliveredCandidate[] = result.pointers.map((pointer, index) => {
          const date = dateByMemoryId.get(pointer.object_id);
          return {
            objectId: pointer.object_id,
            content: contentByMemoryId.get(pointer.object_id) ?? "",
            sessionId: sessionByMemoryId.get(pointer.object_id) ?? null,
            sourceRank: index + 1,
            ...(date === undefined || date === null ? {} : { eventDate: date })
          };
        });
        const locomoQuestionType = resolveLocomoQaQuestionType(qa);
        let delivered: QaDeliveredCandidate[] = widePool;
        // Q1: shared LLM relevance filter (default-off; mirrors LongMemEval).
        if (process.env.ALAYA_BENCH_QA_LLM_FILTER !== undefined) {
          const filterK = readPositiveEnv("ALAYA_BENCH_QA_LLM_FILTER_K", 30);
          const filterM = readPositiveEnv("ALAYA_BENCH_QA_LLM_FILTER_M", 8);
          const selected = await selectRelevantMemories(
            qa.question,
            widePool.slice(0, filterK),
            filterM,
            opts.qa.chat
          );
          if (selected.length > 0) delivered = selected;
        }
        // Q2: deterministic same-session support pack (default-off).
        if (process.env.ALAYA_BENCH_QA_SUPPORT_PACK !== undefined) {
          delivered = buildQaSupportPack({
            questionType: locomoQuestionType,
            selected: delivered,
            widePool,
            maxDeliver: readPositiveEnv("ALAYA_BENCH_QA_SUPPORT_PACK_MAX", 16)
          });
        }
        const qaVerdict = await scoreQaQuestion(
          {
            questionId,
            questionType: locomoQuestionType,
            isAbstention,
            question: qa.question,
            questionDate: conversationNowDate,
            goldAnswer: resolveLocomoQaGoldAnswer(qa),
            delivered
          },
          opts.qa.chat,
          opts.qa.judgeChat ?? opts.qa.chat
        );
        qaVerdicts.push(qaVerdict);
        // Per-LoCoMo-category tally (1 single-hop / 2 temporal / 3 multi-hop /
        // 4 open-domain). questionType collapses to temporal|factual for the
        // judge template, so track the raw category separately for ≥90/category.
        qaCategoryRows.push({ category: qa.category, correct: qaVerdict.correct });
        // Per-question QA dump for failure diagnosis (recall-miss vs reader).
        // Default off; set ALAYA_BENCH_QA_DUMP to a file path.
        if (process.env.ALAYA_BENCH_QA_DUMP !== undefined) {
          appendFileSync(
            process.env.ALAYA_BENCH_QA_DUMP,
            JSON.stringify({
              questionId,
              category: qa.category,
              hitAt5: retrievalScorable ? hit5 : null,
              question: qa.question,
              goldAnswer: String(qa.answer),
              modelAnswer: qaVerdict.modelAnswer,
              correct: qaVerdict.correct,
              delivered: delivered.slice(0, 5).map((d) => ({
                objectId: d.objectId,
                content: d.content.replace(/\s+/gu, " ").slice(0, 200)
              }))
            }) + "\n"
          );
        }
      }
    }

    // Read the EventLog-derived token economy after seeding + every recall, so
    // all seed signals and context-lens events are persisted. Before detach.
    const tokenMetrics = await workspace.queryTokenMetrics();

    return {
      qaCount: scoredCount,
      hitAt1,
      hitAt5,
      hitAt10,
      tierHot,
      tierWarm,
      tierCold,
      latencies,
      questionDiagnostics,
      embeddingWarmup,
      queryEmbeddingWarmup,
      recallTokenEconomySamples,
      tokenMetrics,
      qaVerdicts,
      qaCategoryRows
    };
  } finally {
    await workspace.detach();
  }
}

interface QaResult {
  readonly latencyMs: number;
  readonly pointers: ReadonlyArray<{ readonly object_id: string; readonly relevance_score: number }>;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
}

async function runQuestion(
  workspace: BenchWorkspaceHandle,
  qa: LocomoQa
): Promise<QaResult> {
  const { deliverK } = resolveQaDeliveryBudget(resolveLocomoQaQuestionType(qa));
  const recallStart = monotonicNowNs();
  const recallResult = await workspace.recall(qa.question, { maxResults: deliverK });
  const latencyMs = monotonicElapsedMs(recallStart);
  const pointers = recallResult.results.slice(0, deliverK).map((pointer) => ({
    object_id: pointer.object_id,
    relevance_score: pointer.relevance_score
  }));
  return {
    latencyMs,
    pointers,
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LocomoEmbeddingVectorCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const expectedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = readySummaries.reduce(
    (max, summary) => Math.max(max, summary.pass_count),
    0
  );

  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: expectedCount === 0 ? 0 : readyCount / expectedCount,
    max_pass_count: maxPassCount
  };
}

function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LocomoQueryEmbeddingCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const requestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = readySummaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...readySummaries].reverse().find((summary) => summary.last_error !== undefined)?.last_error;

  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: requestedCount === 0 ? 0 : readyCount / requestedCount,
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

// invariant: sample_size counts the retrieval denominator across the full
// dataset (every QA carrying non-empty evidence), not the number of
// conversations. Answerless adversarial rows still exercise retrieval when
// they point at gold evidence; abstention only changes the optional QA judge
// path. evaluated_count is the subset this run actually scored, so
// evaluated_count <= sample_size holds even when --limit slices the
// conversation window.
export function resolveLocomoSampleSize(
  conversations: readonly LocomoSample[]
): number {
  let total = 0;
  for (const conv of conversations) {
    for (const qa of conv.qa) {
      if (hasLocomoRetrievalEvidence(qa)) {
        total += 1;
      }
    }
  }
  return total;
}

// invariant: identical seed string at both call sites (live seed + extraction
// cache-key collection), else the extraction cache key mismatches and seeds
// diverge. Image turns splice blip_caption / query so the answer signal a
// deictic text ("take a look") drops is recoverable by lexical recall.
export function buildLocomoSeedContent(turn: LocomoTurn): string {
  const caption = turn.blip_caption?.trim() ?? "";
  const query = turn.query?.trim() ?? "";
  return [
    `${turn.speaker}: ${turn.text}`,
    caption.length > 0 ? `[image: ${caption}]` : "",
    query.length > 0 ? `[image query: ${query}]` : ""
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function collectDistinctLocomoTurnContents(
  conversations: readonly LocomoSample[]
): readonly string[] {
  const turns = new Set<string>();
  for (const conversation of conversations) {
    for (const session of extractSessions(conversation.conversation)) {
      for (const turn of session.turns) {
        const content = buildLocomoSeedContent(turn).trim();
        if (content.length > 0) {
          turns.add(content);
        }
      }
    }
  }
  return [...turns];
}

function hasLocomoRetrievalEvidence(qa: LocomoQa): boolean {
  return qa.evidence.length > 0;
}

function isLocomoAbstentionQa(qa: LocomoQa): boolean {
  return qa.answer.trim().length === 0;
}

function resolveLocomoQaGoldAnswer(qa: LocomoQa): string {
  if (!isLocomoAbstentionQa(qa)) {
    return qa.answer;
  }
  return "The conversation does not provide enough information to answer this question.";
}

function shouldRunLocomoRecall(
  qa: LocomoQa,
  opts: LocomoRunOptions
): boolean {
  return hasLocomoRetrievalEvidence(qa) || opts.qa !== undefined;
}

export function resolveLocomoQaQuestionType(qa: LocomoQa): string {
  if (qa.category === 2) {
    return "temporal-reasoning";
  }
  if (qa.category === 3) {
    return "locomo-aggregation";
  }
  if (qa.category === 4) {
    return "locomo-open-domain";
  }
  return "locomo-factual";
}

function readPositiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function buildLocomoQuestionId(sampleId: string, qaIndex: number): string {
  return `${sampleId}:${qaIndex + 1}`;
}

function resolveLocomoGoldMemoryIds(input: {
  readonly questionId: string;
  readonly evidenceSet: ReadonlySet<string>;
  readonly memoryIdsByDiaId: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const goldMemoryIds: string[] = [];
  const missingDiaIds: string[] = [];
  for (const diaId of input.evidenceSet) {
    const memoryIds = input.memoryIdsByDiaId.get(diaId) ?? [];
    if (memoryIds.length === 0) {
      missingDiaIds.push(diaId);
      continue;
    }
    goldMemoryIds.push(...memoryIds);
  }
  if (missingDiaIds.length > 0) {
    throw new Error(
      `LoCoMo seed materialization lost gold evidence for ${input.questionId}: ` +
        missingDiaIds.join(", ")
    );
  }
  return goldMemoryIds;
}
