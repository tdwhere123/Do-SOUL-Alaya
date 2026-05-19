import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../version.js";
import {
  benchArchiveDiscriminator,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchEmbeddingMode,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type SeedObjectKind
} from "../harness/daemon.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic,
  type LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import {
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./archive-evidence.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import type { LongMemEvalVariant } from "./dataset.js";

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
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
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
 * Scoring: object_id sidecar. Each seeded turn produces a durable memory
 * via the MCP propose+review chain (see harness/daemon.ts proposeMemory).
 * The returned memoryId is the durable object_id that soul.recall returns
 * in pointer.object_id, so scoring is by id equality — never by string
 * preview overlap.
 *
 * Hit rule: a recall result is a hit iff its object_id maps in the sidecar
 * to a seed whose hasAnswer === true AND whose sessionId is in
 * question.answer_session_ids.
 * `active_constraints[]` is an independent governance channel and is
 * recorded in diagnostics only; it is never counted toward R@K.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemory chain
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
    reportUsageStats: LongMemEvalReportSimulationStats;
    reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
  };

  async function runOneQuestion(
    question: typeof window[number],
    turnIndex: number
  ): Promise<WorkerResult> {
    const daemon = await startBenchDaemon({
      workspaceId: `lme-${question.question_id.slice(0, 8)}`,
      runId: `run-${question.question_id.slice(0, 8)}`,
      embeddingMode: opts.embeddingMode ?? "disabled",
      recallWeightOverrides
    });
    try {
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

        for (let ti = 0; ti < session.length; ti++) {
          const turn = session[ti];
          if (turn === undefined) continue;

          const evidenceRef = `${question.question_id}-s${si}-t${ti}`;
          const objectKind = resolveLongMemEvalSeedObjectKind({
            seedIndex
          });
          const seed = await daemon.proposeMemory(turn.content, evidenceRef, {
            objectKind
          });
          seedIndex += 1;
          if (seed.truncated) {
            seedTurnsTruncated++;
            seedCharsClipped += seed.charsClipped;
            if (turn.has_answer === true) answerTurnsTruncated++;
          }
          sidecar.set(seed.memoryId, {
            sessionId,
            hasAnswer: turn.has_answer === true
          });
        }
      }

      if (opts.embeddingMode === "env") {
        await daemon.runtime.runGardenBackgroundPass();
      }

      const goldMemoryIds = [...sidecar.entries()]
        .filter(
          ([, meta]) =>
            meta.hasAnswer && answerSessionSet.has(meta.sessionId)
        )
        .map(([memoryId]) => memoryId);

      const recallCycle = await runLongMemEvalRecallCycle({
        daemon,
        query: question.question,
        recallOptions,
        simulateReport,
        goldMemoryIds,
        turnIndex,
        questionText: question.question
      });
      const recallResult = recallCycle.scoredRecallResult;
      const latencyMs = recallCycle.scoredRecallLatencyMs;
      const results = recallResult.results;
      const activeConstraintResults = (recallResult.active_constraints ?? []).map((constraint, index) => ({
        object_id: constraint.object_id,
        rank: index + 1
      }));
      const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
        object_id: pointer.object_id,
        rank: index + 1,
        relevance_score: pointer.relevance_score,
        score_factors: pointer.score_factors ?? null
      }));

      const hitScoring = scoreLongMemEvalRecallHits({
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
        hitAt1: hitScoring.hitAt1,
        hitAt5: hitScoring.hitAt5,
        hitAt10: hitScoring.hitAt10,
        degradationReason: recallResult.degradation_reason ?? null,
        recallResult,
        embeddingMode: opts.embeddingMode ?? "disabled"
      });
      const reportSideEffectSnapshot =
        await readLongMemEvalReportSideEffectSnapshot(question.question_id, daemon);

      return {
        questionId: question.question_id,
        hitAt1: hitScoring.hitAt1,
        hitAt5: hitScoring.hitAt5,
        hitAt10: hitScoring.hitAt10,
        firstTier: hitScoring.firstTier,
        latencyMs,
        degradationReason: recallResult.degradation_reason ?? null,
        seedTurnsTruncated,
        answerTurnsTruncated,
        seedCharsClipped,
        diagnostics,
        reportUsageStats: recallCycle.reportUsageStats,
        reportSideEffectSnapshot
      };
    } finally {
      await daemon.shutdown();
    }
  }

  // @anchor longmemeval-sequential: intra-process concurrency races
  // on the process.env mutated by startBenchDaemon (DATA_DIR /
  // ALAYA_CONFIG_DIR / HOME / ALAYA_REVIEWER_*).
  // see also: apps/bench-runner/scripts/run-full-public-bench.sh for
  // safe process-level sharding.
  const collected: WorkerResult[] = [];
  for (let i = 0; i < window.length; i++) {
    const q = window[i];
    if (q === undefined) continue;
    const res = await runOneQuestion(q, i + 1);
    collected.push(res);
    process.stdout.write(
      `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
        `R@5=${res.hitAt5 ? "✓" : "✗"} latency=${res.latencyMs}ms\n`
    );
  }

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
  const reportSideEffectSnapshots: LongMemEvalReportSideEffectSnapshot[] = [];

  for (let i = 0; i < collected.length; i++) {
    const res = collected[i];
    if (res === null || res === undefined) continue;
    questionDiagnostics.push(res.diagnostics);
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
            provider_failed_rate: providerSummary.provider_failed_rate
          }
        : {}),
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
      // @anchor token_saved_ratio: set to 0 until a token-budget baseline exists
      token_saved_ratio_vs_full_prompt: 0,
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
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
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
    embeddingProvider: payload.embedding_provider
  });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(
    runAt,
    commitSha7,
    benchArchiveDiscriminator(policyShape, simulateReport)
  );

  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const reportSideEffects = summarizeLongMemEvalReportSideEffects({
    mode: simulateReport,
    snapshots: reportSideEffectSnapshots
  });
  const scoredRecallEvidence =
    summarizeLongMemEvalRecallEvidence(questionDiagnostics);

  const diagnosticsSidecar = renderDiagnosticsSidecar({
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
    provider_state_summary: providerSummary,
    questions: questionDiagnostics
  });
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
        contents: diagnosticsSidecar
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
  daemon: Pick<BenchDaemonHandle, "runtime" | "workspaceId">
): Promise<LongMemEvalReportSideEffectSnapshot> {
  const status = await daemon.runtime.services.graphHealthService.getStatus(
    daemon.workspaceId
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
  readonly results: readonly { readonly object_id: string }[];
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
  const deliveredIds = new Set(deliveredResults.map((result) => result.object_id));
  const goldIds = new Set(input.goldMemoryIds);
  const deliveredGoldIds = deliveredResults
    .map((result) => result.object_id)
    .filter((objectId) => goldIds.has(objectId));

  let usedObjectIds: string[] = [];
  if (input.simulateReport === "gold-only") {
    usedObjectIds = deliveredGoldIds;
  } else if (input.simulateReport === "mixed") {
    if (deliveredGoldIds.length > 0) {
      const firstNonGold = deliveredResults.find(
        (result) => !goldIds.has(result.object_id)
      );
      usedObjectIds =
        firstNonGold === undefined
          ? deliveredGoldIds
          : [...deliveredGoldIds, firstNonGold.object_id];
    } else {
      usedObjectIds =
        deliveredResults[0] === undefined ? [] : [deliveredResults[0].object_id];
    }
  } else if (input.simulateReport === "always-used") {
    usedObjectIds =
      deliveredResults[0] === undefined ? [] : [deliveredResults[0].object_id];
  }

  const safeUsedObjectIds = usedObjectIds.filter((objectId) => deliveredIds.has(objectId));
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
      usageStatus: usedSet.has(result.object_id) ? "used" : "skipped"
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
    const meta = input.sidecar.get(pointer.object_id);
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

export function resolveLongMemEvalSeedObjectKind(input: {
  readonly seedIndex: number;
}): SeedObjectKind {
  void input;
  return "fact";
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

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

export type { LongMemEvalVariant };
