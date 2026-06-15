import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchRunnerVersion
} from "../shared/version.js";
import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
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
  type BenchTokenMetrics
} from "../harness/daemon.js";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract
} from "../harness/token-economy.js";
import { aggregateRecallTokenEconomy } from "./recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  summarizeProviderStates,
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
import { loadDataset, type FetchResult } from "./fetch.js";
import { type LongMemEvalVariant } from "./dataset.js";
import { collectDistinctTurnContents } from "./extraction-fill.js";
import { selectFullRunBaseline } from "./recall-eval-archive.js";
import {
  createCompileSeedRunner,
  resolveBenchAllowLiveExtraction,
  toSeedExtractionPathKpi,
} from "./compile-seed.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "./seed-extraction-release-blocker.js";
import { type LongMemEvalSnapshotQuestion } from "./snapshot.js";
import { EXTRACTION_CACHE_ROOT } from "./compile-seed.js";
import {
  aggregateQaVerdicts,
  type QaQuestionVerdict
} from "./qa-harness.js";
import { QaChatError, type QaChatFn } from "./qa-chat.js";
import {
  computePercentile,
  readLongMemEvalPinnedMeta,
  recallOptionsForPolicyShape,
  resolveBenchEmbeddingProviderLabel,
  resolveCommitSha7,
  summarizeEmbeddingVectorCache,
  summarizeQueryEmbeddingCache,
  writeRecallEvalSnapshot
} from "./runner-helpers.js";
import {
  runLongMemEvalQuestion,
  type LongMemEvalWorkerResult
} from "./runner-question.js";
export {
  buildLongMemEvalReportContextUsage,
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  resolveLongMemEvalHitVerdict,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits,
  type LongMemEvalBenchRecallResult,
  type LongMemEvalHitScoringInput,
  type LongMemEvalHitScoringResult,
  type LongMemEvalReportSimulationStats,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
const LONGMEMEVAL_SEED_POLICY = Object.freeze({
  mode: "label_independent_all_fact",
  label_independent: true,
  object_kind: "fact",
  description:
    "LongMemEval public recall evaluation seeds every haystack turn as a factual memory; has_answer labels are used only for scoring sidecars."
});

// End-to-end QA option, shape mirrors cli.ts qaOption (chat fn + model labels).
export interface LongMemEvalQaRunOption {
  readonly chat: QaChatFn;
  /** Judge chat fn; defaults to `chat` (answer model) when omitted. */
  readonly judgeChat?: QaChatFn;
  readonly answerModel: string;
  readonly judgeModel: string;
}

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
  // @anchor longmemeval-datadir-root: pin the bench daemon's DB to a fixed
  // directory instead of a throwaway mkdtemp, so the seeded DB can be
  // snapshotted for the recall-eval fast loop. Defaults to undefined (the
  // daemon allocates its own mkdtemp), preserving existing behaviour.
  // see also: apps/bench-runner/src/harness/daemon.ts startBenchDaemon
  //   (dataDirRoot)
  readonly dataDirRoot?: string;
  // @anchor longmemeval-snapshot-out: when set, after the run completes the
  // seeded DB is WAL-checkpointed + copied to this path, and the per-question
  // scoring sidecar + a version-binding manifest are written beside it, so a
  // later recall-eval --snapshot run skips both extraction and
  // materialization. see also: apps/bench-runner/src/longmemeval/snapshot.ts
  readonly snapshotOut?: string;
  // Override the extraction-cache root the run-start preflight validates and
  // the snapshot sidecar records provenance from (test-only). Production
  // callers leave this undefined so the canonical EXTRACTION_CACHE_ROOT is
  // used. Tests point it at an isolated dir so the run validates a hand-built
  // cache + arbitrary model instead of the committed production manifest,
  // decoupling the integration tests from the live extraction model.
  readonly extractionCacheRoot?: string;
  // @anchor longmemeval-qa: end-to-end QA scoring (answer-LLM + LLM-judge over
  // delivered recall). Undefined => zero LLM calls and byte-identical kpi/sidecar.
  readonly qa?: LongMemEvalQaRunOption;
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
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
 * recall-optimization runs.
 *
 * `active_constraints[]` is an independent governance channel and is
 * recorded in diagnostics only; it is never counted toward R@K.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemoryFromSignal
 * see also: packages/eval/src/reporting/report.ts — report.md "Scoring contract"
 *   section; its LongMemEval-S text must mirror this measurement-basis
 *   note (the report.md prose lives there, not in this package).
 */

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
  // The run-start preflight (createCompileSeedRunner) and the snapshot sidecar
  // provenance both read this cache root. Default to the canonical production
  // cache; a test override points it at an isolated dir.
  const extractionCacheRoot = opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT;
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled",
    process.env,
    opts.embeddingProviderKind ?? "openai"
  );
  const policyShape = opts.policyShape ?? "stress";
  const simulateReport = opts.simulateReport ?? "none";
  const recallOptions = recallOptionsForPolicyShape(policyShape);
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
  // @anchor longmemeval-window-containment-preflight: hand the preflight THIS
  // run's flattened question window so it validates window-containment (every
  // turn this run needs has an on-disk fixture) rather than trusting the
  // manifest coverage scalar, which is only relative to the last
  // extraction-fill's window. cross-file: compile-seed.ts preflightExtractionCache
  const requiredTurnContents = collectDistinctTurnContents(window);
  const seedRunner = createCompileSeedRunner({
    requiredTurnContents,
    cacheRoot: extractionCacheRoot,
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
  const collected: LongMemEvalWorkerResult[] = [];
  // @anchor longmemeval-snapshot-capture: when seeding for a recall-eval
  // snapshot, capture each question's scoring sidecar + workspace ids so they
  // can be persisted beside the DB (the seed loop otherwise discards them).
  const snapshotQuestions: LongMemEvalSnapshotQuestion[] = [];
  const captureSnapshot = opts.snapshotOut !== undefined;
  const benchRunId = `lme-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // dataDirRoot is pinned (not the daemon's throwaway mkdtemp) when a fixed
  // dataDirRoot is requested OR a snapshot is being produced, so the seeded DB
  // lands at a known path to checkpoint + copy.
  const seedDataDirRoot =
    opts.dataDirRoot ??
    (captureSnapshot
      ? await mkdtemp(join(tmpdir(), "alaya-bench-seed-"))
      : undefined);
  const removeSeedDataDirRoot = opts.dataDirRoot === undefined && captureSnapshot;
  let daemon: BenchDaemonHandle | undefined;
  try {
    daemon = await startBenchDaemon({
      workspaceId: `${benchRunId}-default`,
      runId: `${benchRunId}-default-run`,
      embeddingMode: opts.embeddingMode ?? "disabled",
      ...(opts.embeddingProviderKind === undefined
        ? {}
        : { embeddingProviderKind: opts.embeddingProviderKind }),
      ...(seedDataDirRoot === undefined ? {} : { dataDirRoot: seedDataDirRoot }),
      recallWeightOverrides
    });
    let questionFailures = 0;
    for (let i = 0; i < window.length; i++) {
      const q = window[i];
      if (q === undefined) continue;
      try {
        const res = await runLongMemEvalQuestion({
          daemon,
          question: q,
          turnIndex: i + 1,
          seedRunner,
          recallOptions,
          simulateReport,
          embeddingMode: opts.embeddingMode ?? "disabled",
          embeddingProviderKind: opts.embeddingProviderKind ?? "openai",
          captureSnapshot,
          ...(opts.qa === undefined
            ? {}
            : {
                qaChat: opts.qa.chat,
                ...(opts.qa.judgeChat === undefined
                  ? {}
                  : { qaJudgeChat: opts.qa.judgeChat })
              })
        });
        collected.push(res);
        if (captureSnapshot && res.snapshotQuestion !== undefined) {
          snapshotQuestions.push(res.snapshotQuestion);
        }
        process.stdout.write(
          `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
            `R@5=${res.hitAt5 ? "✓" : "✗"} latency=${res.latencyMs}ms\n`
        );
      } catch (err) {
        // Resilience: skip only a transient QA-chat failure (an API error that
        // survived its retries) so one bad question never aborts a multi-hour
        // run. A fail-closed invariant (e.g. incomplete embedding cache) is
        // re-thrown and still aborts. KPIs then cover the completed Qs.
        if (!(err instanceof QaChatError)) throw err;
        questionFailures += 1;
        process.stderr.write(
          `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} FAILED — ` +
            `skipped: ${err.message}\n`
        );
      }
    }
    if (questionFailures > 0) {
      process.stdout.write(
        `[longmemeval] ${questionFailures}/${window.length} question(s) failed ` +
          `and were skipped; KPIs cover the ${collected.length} completed.\n`
      );
    }
    // @anchor longmemeval-seed-then-snapshot: emit the recall-eval snapshot
    // while the daemon DB connection is still open, so wal_checkpoint flushes
    // every committed frame before the file copy. Runs only with --snapshot-out.
    if (opts.snapshotOut !== undefined && seedDataDirRoot !== undefined) {
      writeRecallEvalSnapshot({
        snapshotOut: opts.snapshotOut,
        seedDataDirRoot,
        variant: opts.variant,
        commitSha7,
        snapshotQuestions,
        extractionCacheRoot
      });
      process.stdout.write(
        `[longmemeval snapshot] wrote ${snapshotQuestions.length} questions -> ${opts.snapshotOut}\n`
      );
    }
  } finally {
    try {
      await daemon?.shutdown();
    } finally {
      if (removeSeedDataDirRoot && seedDataDirRoot !== undefined) {
        await rm(seedDataDirRoot, { recursive: true, force: true });
      }
    }
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
  // @anchor edge-proposal-rate-per-question: keep per-question row chunks
  // so aggregateEdgeProposalRate can emit the proposals_per_question
  // distribution. K3.2's "40-80/workspace/day" target is uninterpretable
  // off per_workspace_per_day_* alone because the bench harness uses
  // one workspaceId per run. see also: packages/eval/src/schema/kpi-schema.ts.
  // The flat across-questions list is derived by flattening these chunks at
  // the aggregator call site rather than stored a second time.
  const edgeProposalKpiRowsPerQuestion: EdgeProposalKpiEventRow[][] = [];
  // QA verdicts collected only when opts.qa is set; empty otherwise.
  const qaVerdicts: QaQuestionVerdict[] = [];

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
    edgeProposalKpiRowsPerQuestion.push([...res.edgeProposalKpiRows]);
    if (res.qaVerdict !== undefined) {
      qaVerdicts.push(res.qaVerdict);
    }
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
  // see also: packages/eval/src/schema/kpi-schema.ts BenchSplit enum.
  const VARIANT_TO_SPLIT: Record<typeof opts.variant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  const split = VARIANT_TO_SPLIT[opts.variant];

  // Event-sourced token economy: aggregate the per-question EventLog-derived
  // figures into one run total, then derive the headline saved ratio.
  const tokenEconomyInput = aggregateBenchTokenMetrics(tokenMetricsPerQuestion);
  // Harness-level contract: a seeded run with no full-turn marker fails closed.
  // see also: apps/bench-runner/src/harness/token-economy.ts assertBenchTokenEconomyContract
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
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
  const edgeProposalKpiRowsAcrossQuestions = edgeProposalKpiRowsPerQuestion.flat();
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeProposalKpiRowsAcrossQuestions,
    edgeProposalKpiRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(
    edgeProposalKpiRowsAcrossQuestions
  );

  // QA accuracy block: emitted only when --qa ran and produced verdicts, so a
  // normal recall run leaves kpi.qa_metrics absent (byte-identical).
  const qaMetrics =
    opts.qa !== undefined && qaVerdicts.length > 0
      ? {
          ...aggregateQaVerdicts(qaVerdicts),
          answer_model: opts.qa.answerModel,
          judge_model: opts.qa.judgeModel
        }
      : undefined;

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
      ...(qaMetrics === undefined ? {} : { qa_metrics: qaMetrics }),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  // Diff against the latest PASSING full-run entry of the SAME split. Oracle vs
  // S are not comparable retrieval evaluations (Oracle's session filter is
  // no-op, S's is meaningful). see also: packages/eval/src/history/history.ts
  // @anchor read-latest-split-aware. selectFullRunBaseline additionally
  // excludes fast-loop recall-eval archives, which share this public/ bucket +
  // passing pointer but never paid extraction/materialization.
  // cross-file: apps/bench-runner/src/longmemeval/recall-eval-archive.ts
  const previous = await selectFullRunBaseline(layout, "public", {
    split: payload.split,
    policyShape,
    simulateReport,
    embeddingProvider: payload.embedding_provider
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

export type { LongMemEvalVariant };
