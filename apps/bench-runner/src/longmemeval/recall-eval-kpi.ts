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
import { buildLongMemEvalQualityMetrics, type LongMemEvalQuestionDiagnostic } from "./diagnostics.js";
import { RECALL_EVAL_ARCHIVE_MARKER } from "./recall-eval-archive.js";
import type { LongMemEvalSnapshotManifest } from "./snapshot.js";
import type { LongMemEvalVariant } from "./dataset.js";
import type { RecallEvalQuestionResult } from "./recall-eval.js";

const VARIANT_TO_SPLIT: Record<LongMemEvalVariant, BenchSplit> = {
  longmemeval_oracle: "longmemeval-oracle",
  longmemeval_s: "longmemeval-s",
  longmemeval_m: "longmemeval-m"
};

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

  for (const res of input.collected) {
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

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);

  const tokenEconomyInput = aggregateBenchTokenMetrics(tokenMetricsPerQuestion);
  // see also: apps/bench-runner/src/harness/token-economy.ts assertBenchTokenEconomyContract
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);
  const recallTokenEconomy = aggregateRecallTokenEconomy(recallTokenEconomySamples);
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeProposalRowsAcross,
    edgeProposalRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(edgeProposalRowsAcross);

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
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
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
      // Provenance-inherited (gate-only): recall-eval never re-seeds, so seed
      // truncation cannot be measured this run. The snapshot's seed run is the
      // gate authority; the fast loop reports zeros so the recall KPI shape
      // stays valid without faking seed-time figures.
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      ...(edgeProposalRate === undefined ? {} : { edge_proposal_rate: edgeProposalRate }),
      ...(edgeProposalAutoAccept === undefined
        ? {}
        : { edge_proposal_auto_accept: edgeProposalAutoAccept }),
      per_scenario: perScenario
    }
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}
