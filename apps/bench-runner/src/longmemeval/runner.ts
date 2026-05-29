import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../version.js";
import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  buildTokenEconomy,
  computeTokenSavedRatio,
  type EdgeProposalKpiEventRow,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEmbeddingWarmupSummary,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import { aggregateBenchTokenMetrics } from "./token-economy.js";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "./recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  summarizeProviderStates,
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary,
  type LongMemEvalQuestionDiagnostic,
  type LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./diagnostics-artifacts.js";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./archive-evidence.js";
import {
  isAbstentionQuestionId,
  scoreAbstentionQuestion
} from "./abstention.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import { pairSessionIntoRounds, type LongMemEvalVariant } from "./dataset.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
const PINNED_META_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets"
);
const LONGMEMEVAL_SEED_POLICY = Object.freeze({
  mode: "label_independent_all_fact",
  label_independent: true,
  object_kind: "fact",
  description:
    "LongMemEval public recall evaluation seeds every haystack turn as a factual memory; has_answer labels are used only for scoring sidecars."
});

export interface LongMemEvalRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  // Override the pinned-checksum lookup root (test-only). Production
  // callers should leave this undefined so the canonical
  // docs/bench-history/datasets path is used.
  readonly pinnedMetaRoot?: string;
  // @anchor longmemeval-offset: skip the first N questions before
  // `limit`. Pairs with process-level sharding in
  // apps/bench-runner/scripts/run-full-public-bench.sh.
  readonly offset?: number;
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

export interface LongMemEvalSidecarEntry {
  readonly objectId: string;
  readonly objectKind: "memory_entry" | "synthesis_capsule";
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
    readonly relevance_score: number;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}

export interface LongMemEvalHitScoringResult {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
}

/**
 * @anchor longmemeval-runner — per-question workspace, seed-then-recall
 *
 * Scoring: object_id sidecar. Each haystack turn is run through the
 * production garden extraction (OfficialApiGardenProvider.compile) into N
 * typed candidate signals, each seeded as a durable memory_entry row via the
 * MCP propose+review chain (see harness/daemon.ts proposeMemoryFromSignal
 * and longmemeval/compile-seed.ts). Every returned memoryId is the durable
 * object_id that soul.recall returns in pointer.object_id, so scoring is by
 * id equality — never by string preview overlap.
 *
 * Hit rule: a recall result is a hit iff it is a memory_entry whose object_id
 * maps in the sidecar to a seed whose hasAnswer === true AND whose sessionId
 * is in question.answer_session_ids. Because one answer turn now seeds N
 * extracted facts, an answer turn maps to N gold object_ids, and a hit means
 * recalling ANY one fact of that answer turn.
 *
 * Synthesis seed: each session also seeds one L2 synthesis_capsule
 * (potential_synthesis -> synthesisService.create). Its durable object_id is
 * tracked in the sidecar under an object-kind namespace so diagnostics can
 * prove it competed in recall without counting it as memory gold.
 *
 * Measurement-basis note: an answer turn seeds N gold objects (the
 * extraction fan-out), not 1. R@K is measured on that basis ("did any
 * extracted fact of the answer turn surface") and is NOT directly
 * comparable to the pre-extraction 110623Z baseline. The first
 * post-extraction full run is the reference baseline for later
 * recall-optimization slices.
 *
 * `active_constraints[]` is an independent governance channel and is
 * recorded in diagnostics only; it is never counted toward R@K.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemoryFromSignal
 * see also: packages/eval/src/report.ts — report.md "Scoring contract"
 *   section; its LongMemEval-S text must mirror this measurement-basis
 *   note (the report.md prose lives there, not in this package).
 */

// @anchor BENCH_PROFILE_TIMER: env-gated per-question phase timer. Default
// OFF; set ALAYA_BENCH_PROFILE=1 to emit one [bench_profile] line per
// question on stderr. Consumed by smoke runs that need to diff per-phase
// distribution (e.g. before/after SQLite tuning). The timer uses
// hrtime.bigint() (ns); rendering converts to ms with one-decimal
// precision. Phases are optional — only those `record`-ed appear in
// the line.
const BENCH_PROFILE_ENV = "ALAYA_BENCH_PROFILE";

function isBenchProfileEnabled(): boolean {
  const raw = process.env[BENCH_PROFILE_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

interface PhaseTimer {
  readonly tick: () => bigint;
  readonly record: (name: string, started: bigint) => void;
  readonly format: () => string;
}

function createPhaseTimer(): PhaseTimer {
  const samples: Array<{ name: string; ms: number }> = [];
  return {
    tick: () => process.hrtime.bigint(),
    record: (name: string, started: bigint) => {
      const elapsedNs = process.hrtime.bigint() - started;
      const ms = Number(elapsedNs) / 1_000_000;
      samples.push({ name, ms });
    },
    format: () => samples.map((s) => `${s.name}=${s.ms.toFixed(1)}ms`).join(" ")
  };
}

export async function runLongMemEval(
  opts: LongMemEvalRunOptions
): Promise<LongMemEvalRunResult> {
  const recallWeightOverrides = resolveBenchRecallWeightOverrides({
    cliJson: opts.weightOverridesJson,
    envJson: process.env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV]
  });
  if (recallWeightOverrides !== undefined) {
    process.stdout.write(
      `[longmemeval weights] ${formatBenchRecallWeightOverrides(recallWeightOverrides)}\n`
    );
  }

  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled"
  );
  const policyShape = opts.policyShape ?? "stress";
  const simulateReport = opts.simulateReport ?? "none";
  const recallOptions = recallOptionsForPolicyShape(policyShape);

  type WorkerResult = {
    questionId: string;
    hitAt1: boolean;
    hitAt5: boolean;
    hitAt10: boolean;
    firstTier: "hot" | "warm" | "cold";
    latencyMs: number;
    degradationReason: string | null;
    seedTurnsTruncated: number;
    answerTurnsTruncated: number;
    seedCharsClipped: number;
    diagnostics: LongMemEvalQuestionDiagnostic;
    embeddingWarmup: BenchEmbeddingWarmupSummary | null;
    queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
    reportUsageStats: LongMemEvalReportSimulationStats;
    reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
    tokenMetrics: BenchTokenMetrics;
    // Per-recall structural token-economy sample from
    // recallResult.diagnostics.token_economy. Null when the degraded
    // recall path (any non-null degradation_reason) omits the
    // token_economy block in core, so the bench extractor returns null
    // and the run-level aggregator drops the sample before computing
    // distribution stats.
    recallTokenEconomy: BenchRecallTokenEconomy | null;
    // Per-question EventLog rows for the K3.2 / K3.4 edge proposal
    // KPI: SOUL_GRAPH_EDGE_PROPOSAL_CREATED + _REVIEWED. Empty when
    // the run produced no proposals; the aggregator still returns
    // undefined in that case so the KPI omits the block.
    edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
  };

  async function runOneQuestion(
    daemon: BenchDaemonHandle,
    question: typeof window[number],
    turnIndex: number,
    seedRunner: CompileSeedRunner
  ): Promise<WorkerResult> {
    // @anchor bench-profile-instrumentation: per-question phase timing,
    // gated by ALAYA_BENCH_PROFILE.
    const profileEnabled = isBenchProfileEnabled();
    const phase = createPhaseTimer();
    const tAttach = phase.tick();
    const workspace: BenchWorkspaceHandle = await daemon.attachWorkspace({
      workspaceId: `lme-${question.question_id.slice(0, 8)}`,
      runId: `run-${question.question_id.slice(0, 8)}`
    });
    phase.record("workspace_attach", tAttach);
    try {
      const tSeedLoop = phase.tick();
      const sidecar = new Map<string, LongMemEvalSidecarEntry>();
      const answerSessionSet = new Set(question.answer_session_ids);
      let seedTurnsTruncated = 0;
      let answerTurnsTruncated = 0;
      let seedCharsClipped = 0;

      let seedIndex = 0;
      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `session-${si}`;
        if (session === undefined) continue;

        // invariant: extract per ROUND (a user message + its assistant
        // response), not per bare message — production POST_TURN_EXTRACT
        // extracts per round and a lone message gives the extractor no
        // context to resolve pronouns/dates. round.hasAnswer is true iff
        // any covered message is answer-bearing, so the sidecar still maps
        // every answer round and recall scoring stays accurate.
        const rounds = pairSessionIntoRounds(session);
        // Per-session turns collected for the L2 synthesis seed below.
        const sessionTurns: SessionSeededTurn[] = [];
        let sessionHasAnswer = false;
        // anchor: session-adjacent derives_from. Carries the prior turn's
        // seeded memory_entry ids so the next turn's signal carries
        // top-level source_memory_refs.
        // see also: packages/soul/src/garden/materialization-router.ts
        //   createAllMemoryRefEdges
        let previousTurnSeedMemoryIds: readonly string[] = [];
        for (let ri = 0; ri < rounds.length; ri++) {
          const round = rounds[ri];
          if (round === undefined) continue;

          const evidenceRef = `${question.question_id}-s${si}-r${ri}`;
          const seedResult = await seedRunner.seedTurn({
            daemon: workspace,
            turnContent: round.content,
            evidenceRefBase: evidenceRef,
            seedIndex,
            workspaceId: workspace.workspaceId,
            runId: workspace.runId,
            ...(previousTurnSeedMemoryIds.length === 0
              ? {}
              : { sourceMemoryRefs: previousTurnSeedMemoryIds })
          });
          seedIndex += 1;
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
          //   apps/bench-runner/src/locomo/runner.ts previousTurnSeedMemoryIds
          previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
        }

        // L2 synthesis seed: emit ONE session-level synthesis capsule pointing
        // at this session's real evidence_capsule ids. It is sidecar-tracked
        // for diagnostics, but memory-gold scoring remains memory_entry-only.
        const synthesisInput = buildSessionSynthesisInput({
          topicKey: `${question.question_id}-s${si}`,
          turns: sessionTurns
        });
        if (synthesisInput !== null) {
          const synthesisResult = await workspace.proposeSynthesis(synthesisInput);
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

      phase.record("seed_loop", tSeedLoop);

      const tEmbeddingWarmup = phase.tick();
      const embeddingWarmup =
        opts.embeddingMode === "env"
          ? await workspace.warmEmbeddingCache(deriveLongMemEvalMemoryObjectIds(sidecar))
          : null;
      const queryEmbeddingWarmup =
        opts.embeddingMode === "env"
          ? await workspace.warmQueryEmbeddingCache([question.question])
          : null;
      phase.record("embedding_warmup", tEmbeddingWarmup);

      const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);

      const tRecall = phase.tick();
      const recallCycle = await runLongMemEvalRecallCycle({
        daemon: workspace,
        query: question.question,
        recallOptions,
        simulateReport,
        goldMemoryIds,
        turnIndex,
        questionText: question.question
      });
      phase.record("recall", tRecall);
      const recallResult = recallCycle.scoredRecallResult;
      const latencyMs = recallCycle.scoredRecallLatencyMs;
      const results = recallResult.results;
      const activeConstraintResults = (recallResult.active_constraints ?? []).map((constraint, index) => ({
        object_id: constraint.object_id,
        rank: index + 1
      }));
      const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
        object_id: pointer.object_id,
        object_kind: pointer.object_kind,
        rank: index + 1,
        relevance_score: pointer.relevance_score,
        score_factors: pointer.score_factors ?? null
      }));

      // Numerator rule: answerable questions score by id-equality hits;
      // abstention (`_abs`) questions score by calibrated confidence — the
      // top-k must stay below the false-confident threshold. The recall@k
      // denominator stays at the full question count for both.
      const isAbstention = isAbstentionQuestionId(question.question_id);
      const scoredHits = resolveLongMemEvalHitVerdict({
        isAbstention,
        results,
        sidecar,
        answerSessionIds: answerSessionSet
      });
      const diagnostics = buildQuestionDiagnostic({
        questionId: question.question_id,
        goldMemoryIds,
        answerSessionIds: question.answer_session_ids,
        deliveredResults,
        activeConstraintResults,
        hitAt1: scoredHits.hitAt1,
        hitAt5: scoredHits.hitAt5,
        hitAt10: scoredHits.hitAt10,
        isAbstention,
        degradationReason: recallResult.degradation_reason ?? null,
        recallResult,
        embeddingMode: opts.embeddingMode ?? "disabled"
      });
      const tKpiQuery = phase.tick();
      const reportSideEffectSnapshot =
        await readLongMemEvalReportSideEffectSnapshot(
          question.question_id,
          daemon,
          workspace.workspaceId
        );
      // Event-sourced token-economy figures for this question's run: read
      // back from the EventLog after the seed loop and every recall, so
      // each contributing SOUL_SIGNAL_EMITTED / SOUL_CONTEXT_LENS_ASSEMBLED
      // row is already persisted. Must run before the finally-shutdown.
      const tokenMetrics = await workspace.queryTokenMetrics();
      // Per-recall STRUCTURAL token-economy sample. Pulled directly off
      // the already-parsed BenchRecallDiagnostics. A null here means
      // RecallService skipped the instrument because the recall was
      // degraded (any non-null degradation_reason — warm/cold cascade
      // or recall_explainability_partial), so diagnostics carry no
      // token_economy block. The aggregator drops nulls before the
      // distribution stats so degraded recalls don't dilute the run.
      // see also: packages/core/src/recall-service.ts
      // (computeRecallTokenEconomy call site).
      const recallTokenEconomy = extractRecallTokenEconomy(recallResult);
      // K3.2 / K3.4 edge proposal KPI rows for this question's run:
      // SOUL_GRAPH_EDGE_PROPOSAL_CREATED + _REVIEWED EventLog rows.
      // Read back after seeding + recall so every auto-accept policy
      // decision is durably persisted before aggregation.
      // see also: packages/eval/src/edge-proposal-kpi.ts
      const edgeProposalKpiRows = await workspace.queryEdgeProposalKpiRows();
      phase.record("kpi_query", tKpiQuery);

      return {
        questionId: question.question_id,
        hitAt1: scoredHits.hitAt1,
        hitAt5: scoredHits.hitAt5,
        hitAt10: scoredHits.hitAt10,
        firstTier: scoredHits.firstTier,
        latencyMs,
        degradationReason: recallResult.degradation_reason ?? null,
        seedTurnsTruncated,
        answerTurnsTruncated,
        seedCharsClipped,
        diagnostics,
        embeddingWarmup,
        queryEmbeddingWarmup,
        reportUsageStats: recallCycle.reportUsageStats,
        reportSideEffectSnapshot,
        tokenMetrics,
        recallTokenEconomy,
        edgeProposalKpiRows
      };
    } finally {
      const tDetach = phase.tick();
      await workspace.detach();
      phase.record("workspace_detach", tDetach);
      if (profileEnabled) {
        process.stderr.write(
          `[bench_profile] question=${question.question_id} ${phase.format()}\n`
        );
      }
    }
  }

  // @anchor longmemeval-sequential: intra-process concurrency races
  // on the process.env mutated by startBenchDaemon (DATA_DIR /
  // ALAYA_CONFIG_DIR / HOME / ALAYA_REVIEWER_*).
  // see also: apps/bench-runner/scripts/run-full-public-bench.sh for
  // safe process-level sharding.
  // invariant: one seed runner for the whole run so the on-disk extraction
  // cache and stats accumulate across every question. Extraction happens at
  // seed time only — never on the recall path below.
  // @anchor longmemeval-daemon-per-run: one bench daemon spans the run;
  // per-question isolation is via daemon.attachWorkspace (BenchDaemonHandle).
  // createCompileSeedRunner() runs a ~1s run-start fail-loud preflight against
  // the extraction cache manifest (model / prompt-sha / coverage); a mismatch
  // throws here instead of silently degrading to a 466h live run.
  // see also: apps/bench-runner/src/longmemeval/compile-seed.ts
  //   preflightExtractionCache
  const seedRunner = createCompileSeedRunner(
    resolveBenchAllowLiveExtraction()
      ? { allowLiveExtraction: true }
      : undefined
  );
  const collected: WorkerResult[] = [];
  const benchRunId = `lme-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const daemon = await startBenchDaemon({
    workspaceId: `${benchRunId}-default`,
    runId: `${benchRunId}-default-run`,
    embeddingMode: opts.embeddingMode ?? "disabled",
    ...(opts.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: opts.embeddingProviderKind }),
    recallWeightOverrides
  });
  try {
    for (let i = 0; i < window.length; i++) {
      const q = window[i];
      if (q === undefined) continue;
      const res = await runOneQuestion(daemon, q, i + 1, seedRunner);
      collected.push(res);
      process.stdout.write(
        `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
          `R@5=${res.hitAt5 ? "✓" : "✗"} latency=${res.latencyMs}ms\n`
      );
    }
  } finally {
    await daemon.shutdown();
  }
  const extractionStats = seedRunner.stats;
  // Disclose which seed path ran: official_api_compile (production garden
  // extraction) vs no_credentials_fallback (degraded full-turn single-fact).
  process.stdout.write(
    `[longmemeval compile-seed] path=${extractionStats.path} ` +
      `cache_hits=${extractionStats.cacheHits} ` +
      `llm_calls=${extractionStats.llmCalls} ` +
      `offline_fallbacks=${extractionStats.offlineFallbacks} ` +
      `facts=${extractionStats.factsProduced} ` +
      `signals_dropped=${extractionStats.signalsDropped}\n`
  );

  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let degradePartial = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;
  let truncSeedTotal = 0;
  let truncAnswerTotal = 0;
  let truncCharsTotal = 0;
  let reportsAttempted = 0;
  let reportsUsed = 0;
  let reportsSkipped = 0;
  let reportUsedObjectCount = 0;
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const tokenMetricsPerQuestion: BenchTokenMetrics[] = [];
  const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];
  const reportSideEffectSnapshots: LongMemEvalReportSideEffectSnapshot[] = [];
  const embeddingWarmups: BenchEmbeddingWarmupSummary[] = [];
  const queryEmbeddingWarmups: BenchQueryEmbeddingWarmupSummary[] = [];
  const edgeProposalKpiRowsAcrossQuestions: EdgeProposalKpiEventRow[] = [];
  // @anchor edge-proposal-rate-per-question: keep per-question row chunks
  // so aggregateEdgeProposalRate can emit the proposals_per_question
  // distribution. K3.2's "40-80/workspace/day" target is uninterpretable
  // off per_workspace_per_day_* alone because the bench harness uses
  // one workspaceId per run. see also: packages/eval/src/kpi-schema.ts.
  const edgeProposalKpiRowsPerQuestion: EdgeProposalKpiEventRow[][] = [];

  for (let i = 0; i < collected.length; i++) {
    const res = collected[i];
    if (res === null || res === undefined) continue;
    questionDiagnostics.push(res.diagnostics);
    if (res.embeddingWarmup !== null) {
      embeddingWarmups.push(res.embeddingWarmup);
    }
    if (res.queryEmbeddingWarmup !== null) {
      queryEmbeddingWarmups.push(res.queryEmbeddingWarmup);
    }
    latencies.push(res.latencyMs);
    if (res.hitAt1) totalHitAt1++;
    if (res.hitAt10) totalHitAt10++;
    if (res.firstTier === "hot") tierHot++;
    else if (res.firstTier === "warm") tierWarm++;
    else tierCold++;
    if (res.degradationReason === "warm_cascade_engaged") degradeWarm++;
    else if (res.degradationReason === "cold_cascade_engaged") degradeCold++;
    else if (res.degradationReason === "recall_explainability_partial") degradePartial++;
    else degradeNone++;
    truncSeedTotal += res.seedTurnsTruncated;
    truncAnswerTotal += res.answerTurnsTruncated;
    truncCharsTotal += res.seedCharsClipped;
    reportsAttempted += res.reportUsageStats.reportsAttempted;
    reportsUsed += res.reportUsageStats.reportsUsed;
    reportsSkipped += res.reportUsageStats.reportsSkipped;
    reportUsedObjectCount += res.reportUsageStats.usedObjectCount;
    reportSideEffectSnapshots.push(res.reportSideEffectSnapshot);
    tokenMetricsPerQuestion.push(res.tokenMetrics);
    if (res.recallTokenEconomy !== null) {
      recallTokenEconomySamples.push(res.recallTokenEconomy);
    }
    for (const row of res.edgeProposalKpiRows) {
      edgeProposalKpiRowsAcrossQuestions.push(row);
    }
    edgeProposalKpiRowsPerQuestion.push([...res.edgeProposalKpiRows]);
    perScenario.push({
      id: res.questionId,
      version: 1,
      hit_at_5: res.hitAt5,
      tier: res.firstTier,
      latency_ms: res.latencyMs
    });
  }

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);
  const providerSummary = summarizeProviderStates(questionDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(questionDiagnostics);
  const embeddingVectorCache = summarizeEmbeddingVectorCache(embeddingWarmups);
  const queryEmbeddingCache = summarizeQueryEmbeddingCache(queryEmbeddingWarmups);

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;
  const pinnedMeta = readLongMemEvalPinnedMeta(
    opts.variant,
    opts.pinnedMetaRoot
  );

  // @anchor variant-to-split: exhaustive Record so a new
  // LongMemEvalVariant without a split mapping is a compile error.
  // see also: packages/eval/src/kpi-schema.ts BenchSplit enum.
  const VARIANT_TO_SPLIT: Record<typeof opts.variant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  const split = VARIANT_TO_SPLIT[opts.variant];

  // Event-sourced token economy: aggregate the per-question EventLog-derived
  // figures into one run total, then derive the headline saved ratio.
  const tokenEconomyInput = aggregateBenchTokenMetrics(tokenMetricsPerQuestion);
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);
  // Per-recall STRUCTURAL token-economy distribution (p50/p95/mean
  // across all recall calls in the run). Null when no question produced
  // diagnostics — the KPI omits the block in that case so consumers do
  // not see a zero-filled section that looks like real data.
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    recallTokenEconomySamples
  );
  // K3.2 / K3.4: aggregate edge proposal create/review EventLog rows
  // collected from every per-question bench daemon into one run total.
  // Each aggregator returns undefined when no events were observed —
  // the KPI omits the block in that case (honest reporting).
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeProposalKpiRowsAcrossQuestions,
    edgeProposalKpiRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(
    edgeProposalKpiRowsAcrossQuestions
  );

  const payload: KpiPayload = {
    bench_name: "public",
    split,
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: policyShape,
    simulate_report: simulateReport,
    ...(recallWeightOverrides === undefined
      ? {}
      : { recall_weight_overrides: recallWeightOverrides.summary }),
    seed_policy: LONGMEMEVAL_SEED_POLICY,
    dataset: {
      name: opts.variant,
      size: datasetSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
      checksum_sha256: pinnedMeta.sha256,
      checksum_source: pinnedMeta.source
    },
    sample_size: datasetSize,
    evaluated_count: window.length,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      ...(opts.embeddingMode === "env"
        ? {
            r_at_5_overall: rAt5,
            ...(rAt5EmbeddingReturned === undefined
              ? {}
              : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
            provider_returned_rate: providerSummary.provider_returned_rate,
            provider_pending_rate: providerSummary.provider_pending_rate,
            provider_failed_rate: providerSummary.provider_failed_rate,
            provider_not_requested_rate:
              providerSummary.provider_not_requested_rate,
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
                })
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
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: degradeNone,
        warm_cascade_engaged: degradeWarm,
        cold_cascade_engaged: degradeCold,
        recall_explainability_partial: degradePartial
      },
      seed_truncation: {
        seed_turns_truncated: truncSeedTotal,
        answer_turns_truncated: truncAnswerTotal,
        seed_chars_clipped: truncCharsTotal
      },
      seed_extraction_path: toSeedExtractionPathKpi(extractionStats),
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      ...(edgeProposalRate === undefined
        ? {}
        : { edge_proposal_rate: edgeProposalRate }),
      ...(edgeProposalAutoAccept === undefined
        ? {}
        : { edge_proposal_auto_accept: edgeProposalAutoAccept }),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  // Diff against the latest entry of the SAME split. Oracle vs S are
  // not comparable retrieval evaluations (Oracle's session filter is
  // no-op, S's is meaningful). See packages/eval/src/history.ts
  // @anchor read-latest-split-aware.
  const previous = await readLatest(layout, "public", {
    split: payload.split,
    policyShape,
    simulateReport,
    embeddingProvider: payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(
    runAt,
    commitSha7,
    benchArchiveDiscriminator(policyShape, simulateReport)
  );

  const report = appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
  const findings = appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
  const reportSideEffects = summarizeLongMemEvalReportSideEffects({
    mode: simulateReport,
    snapshots: reportSideEffectSnapshots
  });
  const scoredRecallEvidence =
    summarizeLongMemEvalRecallEvidence(questionDiagnostics);

  const diagnosticsPayload = {
    schema_version: 1,
    bench_name: "public",
    split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: opts.embeddingMode ?? "disabled",
    policy_shape: policyShape,
    simulate_report: simulateReport,
    report_usage: {
      mode: simulateReport,
      reports_attempted: reportsAttempted,
      reports_used: reportsUsed,
      reports_skipped: reportsSkipped,
      used_object_count: reportUsedObjectCount
    },
    report_side_effects: reportSideEffects,
    scored_recall_evidence: scoredRecallEvidence,
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    provider_state_summary: providerSummary,
    questions: questionDiagnostics
  } as const;
  const diagnosticsSidecar = renderDiagnosticsSidecar(diagnosticsPayload);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: opts.historyRoot,
    benchName: "public",
    slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: diagnosticsSidecar
  });
  const compactDiagnosticsSidecar = renderCompactDiagnosticsSidecar(
    diagnosticsPayload,
    diagnosticsArtifactPath
  );
  const currentEvidence = {
    report_side_effects: reportSideEffects,
    scored_recall_evidence: scoredRecallEvidence
  };
  const opposite = await readLatestLongMemEvalOppositeArchive({
    layout,
    current: payload
  });
  const comparisonSidecar = renderLongMemEvalColdWarmComparisonSidecar(
    buildLongMemEvalColdWarmComparisonSidecar({
      currentSlug: slug,
      current: payload,
      currentEvidence,
      opposite
    })
  );
  const entry = await writeEntry(layout, "public", slug, payload, report, findings, {
    sidecars: [
      {
        filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
        contents: compactDiagnosticsSidecar
      },
      {
        filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
        contents: comparisonSidecar
      }
    ]
  });
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

interface LongMemEvalReportSimulationStats {
  readonly reportsAttempted: number;
  readonly reportsUsed: number;
  readonly reportsSkipped: number;
  readonly usedObjectCount: number;
}

export type LongMemEvalBenchRecallResult = Awaited<
  ReturnType<BenchDaemonHandle["recall"]>
>;

export interface LongMemEvalRecallCycleResult {
  readonly scoredRecallResult: LongMemEvalBenchRecallResult;
  readonly scoredRecallLatencyMs: number;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
}

export async function runLongMemEvalRecallCycle(input: {
  readonly daemon: Pick<BenchDaemonHandle, "recall" | "reportContextUsage">;
  readonly query: string;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): Promise<LongMemEvalRecallCycleResult> {
  if (input.simulateReport === "none") {
    const recallStart = Date.now();
    const scoredRecallResult = await input.daemon.recall(
      input.query,
      input.recallOptions
    );
    return {
      scoredRecallResult,
      scoredRecallLatencyMs: Date.now() - recallStart,
      reportUsageStats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const preReportRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  const reportUsage = buildLongMemEvalReportContextUsage({
    simulateReport: input.simulateReport,
    deliveryId: preReportRecallResult.delivery_id,
    results: preReportRecallResult.results,
    goldMemoryIds: input.goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });
  if (reportUsage.reportInput !== null) {
    await input.daemon.reportContextUsage(reportUsage.reportInput);
  }

  const recallStart = Date.now();
  const scoredRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  return {
    scoredRecallResult,
    scoredRecallLatencyMs: Date.now() - recallStart,
    reportUsageStats: reportUsage.stats
  };
}

async function readLongMemEvalReportSideEffectSnapshot(
  questionId: string,
  daemon: Pick<BenchDaemonHandle, "runtime">,
  workspaceId: string
): Promise<LongMemEvalReportSideEffectSnapshot> {
  const status = await daemon.runtime.services.graphHealthService.getStatus(
    workspaceId
  );
  const byType = { ...status.memory_graph_edges_by_type };
  return {
    question_id: questionId,
    workspace_id: status.workspace_id,
    memory_graph_edges_total: status.memory_graph_edges_total,
    memory_graph_edges_by_type: byType,
    recalls_edge_count: byType.recalls ?? 0,
    path_relations_total: status.path_relations_total,
    latest_path_event_at: status.latest_path_event_at,
    warnings: status.warnings
  };
}

export function buildLongMemEvalReportContextUsage(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
  }[];
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): {
  readonly reportInput: BenchReportContextUsageInput | null;
  readonly stats: LongMemEvalReportSimulationStats;
} {
  if (input.simulateReport === "none") {
    return {
      reportInput: null,
      stats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const deliveredResults = input.results.slice(0, 10);
  const deliveredMemoryResults = deliveredResults.filter(isLongMemEvalGoldEligibleResult);
  const deliveredMemoryIds = new Set(deliveredMemoryResults.map((result) => result.object_id));
  const goldIds = new Set(input.goldMemoryIds);
  const deliveredGoldIds = deliveredMemoryResults
    .map((result) => result.object_id)
    .filter((objectId) => goldIds.has(objectId));

  let usedObjectIds: string[] = [];
  if (input.simulateReport === "gold-only") {
    usedObjectIds = deliveredGoldIds;
  } else if (input.simulateReport === "mixed") {
    if (deliveredGoldIds.length > 0) {
      const firstNonGold = deliveredMemoryResults.find(
        (result) => !goldIds.has(result.object_id)
      );
      usedObjectIds =
        firstNonGold === undefined
          ? deliveredGoldIds
          : [...deliveredGoldIds, firstNonGold.object_id];
    } else {
      usedObjectIds =
        deliveredMemoryResults[0] === undefined ? [] : [deliveredMemoryResults[0].object_id];
    }
  } else if (input.simulateReport === "always-used") {
    usedObjectIds =
      deliveredMemoryResults[0] === undefined ? [] : [deliveredMemoryResults[0].object_id];
  }

  const safeUsedObjectIds = usedObjectIds.filter((objectId) => deliveredMemoryIds.has(objectId));
  const usedSet = new Set(safeUsedObjectIds);
  const usageState = safeUsedObjectIds.length > 0 ? "used" : "skipped";
  const reportInput: BenchReportContextUsageInput = {
    deliveryId: input.deliveryId,
    usageState,
    ...(safeUsedObjectIds.length === 0
      ? {}
      : { usedObjectIds: safeUsedObjectIds }),
    deliveredObjects: deliveredResults.map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      usageStatus:
        isLongMemEvalGoldEligibleResult(result) &&
        usedSet.has(result.object_id)
          ? "used"
          : "skipped"
    })),
    turnIndex: input.turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: truncateExcerpt(input.questionText)
        }
      ]
    },
    reason:
      usageState === "used"
        ? `LongMemEval simulate_report=${input.simulateReport}: reported delivered object usage.`
        : `LongMemEval simulate_report=${input.simulateReport}: no delivered object selected.`
  };

  return {
    reportInput,
    stats: {
      reportsAttempted: 1,
      reportsUsed: usageState === "used" ? 1 : 0,
      reportsSkipped: usageState === "skipped" ? 1 : 0,
      usedObjectCount: safeUsedObjectIds.length
    }
  };
}

export function resolveBenchEmbeddingProviderLabel(
  embeddingMode: BenchEmbeddingMode,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  if (embeddingMode === "disabled") {
    return "none";
  }

  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
  const providerUrl = env.OPENAI_EMBEDDING_PROVIDER_URL?.trim();
  if (providerUrl === undefined || providerUrl.length === 0) {
    return `openai:${model}`;
  }

  return `${labelEmbeddingProviderUrl(providerUrl)}:${model}`;
}

function labelEmbeddingProviderUrl(providerUrl: string): string {
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    if (hostname.includes("yunwu")) {
      return "yunwu";
    }
  } catch {
    return "openai-compatible";
  }

  return "openai-compatible";
}

function recallOptionsForPolicyShape(
  policyShape: BenchPolicyShape
): { readonly maxResults: 10; readonly conflictAwareness: boolean } {
  return {
    maxResults: 10,
    conflictAwareness: policyShape === "stress"
  };
}

/**
 * Resolve the per-k hit verdict for one LongMemEval question.
 *
 * Answerable questions keep the byte-identical id-equality scoring of
 * {@link scoreLongMemEvalRecallHits}. Abstention questions are re-scored by
 * calibrated confidence (see longmemeval/abstention.ts): "hit at k" means
 * recall stayed appropriately unconfident across the top-k. `firstTier` is
 * always derived from the actual top-1 relevance_score so tier reporting is
 * unchanged.
 */
export function resolveLongMemEvalHitVerdict(
  input: LongMemEvalHitScoringInput & { readonly isAbstention: boolean }
): LongMemEvalHitScoringResult {
  if (!input.isAbstention) {
    return scoreLongMemEvalRecallHits(input);
  }
  const abstention = scoreAbstentionQuestion({ results: input.results });
  const firstResult = input.results[0];
  return {
    hitAt1: abstention.correctAt1,
    hitAt5: abstention.correctAt5,
    hitAt10: abstention.correctAt10,
    firstTier:
      firstResult === undefined
        ? "cold"
        : inferTier(firstResult.relevance_score)
  };
}

export function scoreLongMemEvalRecallHits(
  input: LongMemEvalHitScoringInput
): LongMemEvalHitScoringResult {
  let hitAt1 = false;
  let hitAt5 = false;
  let hitAt10 = false;
  let firstTier: "hot" | "warm" | "cold" = "cold";

  for (let rank = 0; rank < input.results.length && rank < 10; rank++) {
    const pointer = input.results[rank];
    if (pointer === undefined) continue;
    if (rank === 0) {
      firstTier = inferTier(pointer.relevance_score);
    }
    if (!isLongMemEvalGoldEligibleResult(pointer)) {
      continue;
    }
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
    );
    const isHit =
      meta !== undefined &&
      meta.hasAnswer &&
      input.answerSessionIds.has(meta.sessionId);
    if (isHit) {
      if (rank === 0) hitAt1 = true;
      if (rank < 5) hitAt5 = true;
      hitAt10 = true;
    }
  }

  return { hitAt1, hitAt5, hitAt10, firstTier };
}

function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

export function buildLongMemEvalSidecarKey(
  objectKind: LongMemEvalSidecarEntry["objectKind"],
  objectId: string
): string {
  return `${objectKind}:${objectId}`;
}

export function deriveLongMemEvalGoldMemoryIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter(
        (entry) =>
          entry.objectKind === "memory_entry" &&
          entry.hasAnswer &&
          answerSessionIds.has(entry.sessionId)
      )
      .map((entry) => entry.objectId)
  );
}

function deriveLongMemEvalMemoryObjectIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter((entry) => entry.objectKind === "memory_entry")
      .map((entry) => entry.objectId)
  );
}

function readLongMemEvalPinnedMeta(
  variant: LongMemEvalVariant,
  root?: string
): { readonly sha256: string; readonly source: string } {
  const source = resolve(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
  const parsed = JSON.parse(readFileSync(source, "utf8")) as {
    sha256?: unknown;
  };
  if (typeof parsed.sha256 !== "string" || parsed.sha256.length === 0) {
    throw new Error(`LongMemEval pinned meta missing sha256: ${source}`);
  }
  return { sha256: parsed.sha256, source };
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

function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LongMemEvalEmbeddingVectorCacheSummary | null {
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
    ready_rate: ratio(readyCount, expectedCount),
    max_pass_count: maxPassCount
  };
}

function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LongMemEvalQueryEmbeddingCacheSummary | null {
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
    ready_rate: ratio(readyCount, requestedCount),
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

export type { LongMemEvalVariant };
