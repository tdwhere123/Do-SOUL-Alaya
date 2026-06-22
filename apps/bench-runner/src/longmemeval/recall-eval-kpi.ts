import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  buildTokenEconomy,
  computeTokenSavedRatio,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type EdgeProposalKpiEventRow,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION } from "../shared/version.js";
import { aggregateBenchTokenMetrics, assertBenchTokenEconomyContract } from "../harness/token-economy.js";
import type { BenchTokenMetrics } from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import { type BenchRecallWeightOverrides } from "../harness/recall-weight-overrides.js";
import { aggregateRecallTokenEconomy } from "./recall-token-economy.js";
import {
  buildLongMemEvalFullGoldCoverage,
  buildLongMemEvalQualityMetrics,
  type LongMemEvalQuestionDiagnostic
} from "./diagnostics.js";
import { RECALL_EVAL_ARCHIVE_MARKER } from "./recall-eval-archive.js";
import type { LongMemEvalSnapshotManifest } from "./snapshot.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { RecallEvalQuestionResult } from "./recall-eval.js";

const VARIANT_TO_SPLIT: Record<LongMemEvalVariant, BenchSplit> = {
  longmemeval_oracle: "longmemeval-oracle",
  longmemeval_s: "longmemeval-s",
  longmemeval_m: "longmemeval-m"
};

interface RecallEvalAccumulator {
  readonly perScenario: PerScenarioRow[];
  readonly latencies: number[];
  readonly questionDiagnostics: LongMemEvalQuestionDiagnostic[];
  readonly tokenMetricsPerQuestion: BenchTokenMetrics[];
  readonly recallTokenEconomySamples: BenchRecallTokenEconomy[];
  readonly edgeProposalRowsAcross: EdgeProposalKpiEventRow[];
  readonly edgeProposalRowsPerQuestion: EdgeProposalKpiEventRow[][];
  readonly tierHot: number;
  readonly tierWarm: number;
  readonly tierCold: number;
  readonly degradeNone: number;
  readonly degradeWarm: number;
  readonly degradeCold: number;
  readonly degradePartial: number;
  readonly totalHitAt1: number;
  readonly totalHitAt10: number;
}

function accumulateRecallEvalRows(
  collected: readonly RecallEvalQuestionResult[]
): RecallEvalAccumulator {
  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const tokenMetricsPerQuestion: BenchTokenMetrics[] = [];
  const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];
  const edgeProposalRowsAcross: EdgeProposalKpiEventRow[] = [];
  const edgeProposalRowsPerQuestion: EdgeProposalKpiEventRow[][] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let degradePartial = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;

  for (const res of collected) {
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
    tokenMetricsPerQuestion.push(res.tokenMetrics);
    if (res.recallTokenEconomy !== null) {
      recallTokenEconomySamples.push(res.recallTokenEconomy);
    }
    for (const row of res.edgeProposalKpiRows) {
      edgeProposalRowsAcross.push(row);
    }
    edgeProposalRowsPerQuestion.push([...res.edgeProposalKpiRows]);
    perScenario.push({
      id: res.questionId,
      version: 1,
      hit_at_5: res.hitAt5,
      tier: res.firstTier,
      latency_ms: res.latencyMs
    });
  }
  return {
    perScenario,
    latencies,
    questionDiagnostics,
    tokenMetricsPerQuestion,
    recallTokenEconomySamples,
    edgeProposalRowsAcross,
    edgeProposalRowsPerQuestion,
    tierHot,
    tierWarm,
    tierCold,
    degradeNone,
    degradeWarm,
    degradeCold,
    degradePartial,
    totalHitAt1,
    totalHitAt10
  };
}

interface RecallEvalAggregates {
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly tokenEconomy: ReturnType<typeof buildTokenEconomy>;
  readonly tokenSavedRatio: number;
  readonly recallTokenEconomy: ReturnType<typeof aggregateRecallTokenEconomy>;
  readonly edgeProposalRate: ReturnType<typeof aggregateEdgeProposalRate>;
  readonly edgeProposalAutoAccept: ReturnType<typeof aggregateEdgeProposalAutoAccept>;
}

function computeRecallEvalAggregates(acc: RecallEvalAccumulator): RecallEvalAggregates {
  const n = acc.perScenario.length;
  const tokenEconomyInput = aggregateBenchTokenMetrics(acc.tokenMetricsPerQuestion);
  // see also: apps/bench-runner/src/harness/token-economy.ts assertBenchTokenEconomyContract
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
  return {
    rAt1: n === 0 ? 0 : acc.totalHitAt1 / n,
    rAt5: n === 0 ? 0 : acc.perScenario.filter((r) => r.hit_at_5).length / n,
    rAt10: n === 0 ? 0 : acc.totalHitAt10 / n,
    latencyP50: computePercentile(acc.latencies, 50),
    latencyP95: computePercentile(acc.latencies, 95),
    tokenEconomy: buildTokenEconomy(tokenEconomyInput),
    tokenSavedRatio: computeTokenSavedRatio(tokenEconomyInput),
    recallTokenEconomy: aggregateRecallTokenEconomy(acc.recallTokenEconomySamples),
    edgeProposalRate: aggregateEdgeProposalRate(
      acc.edgeProposalRowsAcross,
      acc.edgeProposalRowsPerQuestion
    ),
    edgeProposalAutoAccept: aggregateEdgeProposalAutoAccept(acc.edgeProposalRowsAcross)
  };
}

export function assembleRecallEvalKpi(input: {
  readonly collected: readonly RecallEvalQuestionResult[];
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly variant: LongMemEvalVariant;
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly alayaVersion: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly sampleSize: number;
  readonly evaluatedCount: number;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
}): KpiPayload {
  const acc = accumulateRecallEvalRows(input.collected);
  const agg = computeRecallEvalAggregates(acc);
  const provenance = input.manifest.extraction_provenance;

  return {
    bench_name: "public",
    split: VARIANT_TO_SPLIT[input.variant],
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: input.policyShape,
    simulate_report: input.simulateReport,
    ...(input.recallWeightOverrides === undefined
      ? {}
      : { recall_weight_overrides: input.recallWeightOverrides.summary }),
    dataset: {
      name: input.variant,
      size: input.sampleSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
      // Provenance-inherited from the snapshot manifest's extraction provenance;
      // recall-eval never re-reads the dataset, so the checksum is carried, not
      // recomputed. "snapshot-inherited" marks a snapshot built without a
      // pinned extraction manifest.
      checksum_sha256: provenance?.dataset_revision ?? "snapshot-inherited",
      // @anchor recall-eval-archive-marker (consumer: selectFullRunBaseline) —
      // the checksum_source MUST start with RECALL_EVAL_ARCHIVE_MARKER so a
      // full-run baseline scan can exclude this fast-loop archive.
      checksum_source: `${RECALL_EVAL_ARCHIVE_MARKER} ${input.manifest.db_filename}`
    },
    sample_size: input.sampleSize,
    evaluated_count: input.evaluatedCount,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: agg.rAt1,
      r_at_5: agg.rAt5,
      r_at_10: agg.rAt10,
      full_gold_coverage: buildLongMemEvalFullGoldCoverage(acc.questionDiagnostics),
      latency_ms_p50: agg.latencyP50,
      latency_ms_p95: agg.latencyP95,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: agg.tokenSavedRatio,
      token_economy: agg.tokenEconomy,
      ...(agg.recallTokenEconomy === null
        ? {}
        : { recall_token_economy: agg.recallTokenEconomy }),
      tier_distribution: { hot: acc.tierHot, warm: acc.tierWarm, cold: acc.tierCold },
      degradation_reasons: {
        none: acc.degradeNone,
        warm_cascade_engaged: acc.degradeWarm,
        cold_cascade_engaged: acc.degradeCold,
        recall_explainability_partial: acc.degradePartial
      },
      // Provenance-inherited (gate-only): recall-eval never re-seeds, so seed
      // truncation cannot be measured this run. The snapshot's seed run is the
      // gate authority; the fast loop reports zeros so the recall KPI shape
      // stays valid without faking seed-time figures.
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: buildLongMemEvalQualityMetrics(acc.questionDiagnostics),
      ...(agg.edgeProposalRate === undefined ? {} : { edge_proposal_rate: agg.edgeProposalRate }),
      ...(agg.edgeProposalAutoAccept === undefined
        ? {}
        : { edge_proposal_auto_accept: agg.edgeProposalAutoAccept }),
      per_scenario: acc.perScenario
    }
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}
