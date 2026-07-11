import type {
  BenchPolicyShape,
  BenchSimulateReportMode,
  BenchSplit,
  KpiPayload
} from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import type { BenchRecallWeightOverrides } from "../../harness/recall-weight-overrides.js";
import { buildLongMemEvalFullGoldCoverage, buildLongMemEvalQualityMetrics } from "../diagnostics.js";
import type { LongMemEvalVariant } from "../dataset.js";
import { RECALL_EVAL_ARCHIVE_MARKER } from "../recall-eval-archive.js";
import type { RecallEvalQuestionResult } from "../recall-eval.js";
import type { RecallEvalRuntimeAttribution } from "../lifecycle/recall-eval-runtime.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot.js";
import { computeRecallEvalAggregates, type RecallEvalAggregates } from "./recall-eval-aggregates.js";
import { accumulateRecallEvalRows, type RecallEvalAccumulator } from "./recall-eval-accumulator.js";

const VARIANT_TO_SPLIT: Record<LongMemEvalVariant, BenchSplit> = {
  longmemeval_oracle: "longmemeval-oracle",
  longmemeval_s: "longmemeval-s",
  longmemeval_m: "longmemeval-m"
};

export interface RecallEvalKpiInput {
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
  readonly embeddingProviderLabel: string;
  readonly runtimeAttribution: RecallEvalRuntimeAttribution;
}

export function assembleRecallEvalKpi(input: RecallEvalKpiInput): KpiPayload {
  const accumulator = accumulateRecallEvalRows(input.collected);
  const aggregates = computeRecallEvalAggregates(accumulator);
  return buildPayload(input, accumulator, aggregates);
}

function buildPayload(
  input: RecallEvalKpiInput,
  accumulator: RecallEvalAccumulator,
  aggregates: RecallEvalAggregates
): KpiPayload {
  return {
    bench_name: "public", split: VARIANT_TO_SPLIT[input.variant],
    run_at: input.runAt.toISOString(), alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion, recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: input.embeddingProviderLabel, chat_provider: "none",
    policy_shape: input.policyShape, simulate_report: input.simulateReport,
    recall_eval_attribution: input.runtimeAttribution,
    ...(input.recallWeightOverrides === undefined ? {} : {
      recall_weight_overrides: input.recallWeightOverrides.summary
    }),
    dataset: {
      name: input.variant, size: input.sampleSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
      checksum_sha256: input.manifest.extraction_provenance?.dataset_revision ?? "snapshot-inherited",
      checksum_source: `${RECALL_EVAL_ARCHIVE_MARKER} ${input.manifest.db_filename}`
    },
    sample_size: input.sampleSize, evaluated_count: input.evaluatedCount,
    harness_mode: "mcp_propose_review",
    kpi: buildKpiCore(accumulator, aggregates)
  };
}

function buildKpiCore(
  accumulator: RecallEvalAccumulator,
  aggregates: RecallEvalAggregates
): KpiPayload["kpi"] {
  return {
    r_at_1: aggregates.rAt1, r_at_5: aggregates.rAt5, r_at_10: aggregates.rAt10,
    full_gold_coverage: buildLongMemEvalFullGoldCoverage(accumulator.questionDiagnostics),
    latency_ms_p50: aggregates.latencyP50, latency_ms_p95: aggregates.latencyP95,
    latency_source: "exact", token_saved_ratio_vs_full_prompt: aggregates.tokenSavedRatio,
    token_economy: aggregates.tokenEconomy,
    ...(aggregates.recallTokenEconomy === null ? {} : {
      recall_token_economy: aggregates.recallTokenEconomy
    }),
    tier_distribution: {
      hot: accumulator.tierHot, warm: accumulator.tierWarm, cold: accumulator.tierCold
    },
    degradation_reasons: {
      none: accumulator.degradeNone,
      warm_cascade_engaged: accumulator.degradeWarm,
      cold_cascade_engaged: accumulator.degradeCold,
      recall_explainability_partial: accumulator.degradePartial
    },
    seed_truncation: {
      seed_turns_truncated: 0, answer_turns_truncated: 0, seed_chars_clipped: 0
    },
    quality_metrics: buildLongMemEvalQualityMetrics(accumulator.questionDiagnostics),
    ...(aggregates.edgeProposalRate === undefined ? {} : {
      edge_proposal_rate: aggregates.edgeProposalRate
    }),
    ...(aggregates.edgeProposalAutoAccept === undefined ? {} : {
      edge_proposal_auto_accept: aggregates.edgeProposalAutoAccept
    }),
    per_scenario: accumulator.perScenario
  };
}
