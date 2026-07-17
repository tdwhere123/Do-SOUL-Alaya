import {
  findLongMemEvalSelectionBindingError,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import type { BenchRecallWeightOverrides } from "../../harness/recall/recall-weight-overrides.js";
import {
  buildLongMemEvalFullGoldCoverage,
  buildLongMemEvalQualityMetrics,
  rAt5WithProviderReturned,
  summarizeProviderStates
} from "../diagnostics.js";
import type { LongMemEvalVariant } from "../ingestion/dataset.js";
import { RECALL_EVAL_ARCHIVE_MARKER } from "../lifecycle/recall-eval/recall-eval-archive-impl.js";
import type { RecallEvalQuestionResult } from "../lifecycle/recall-eval/recall-eval-impl.js";
import type { RecallEvalRuntimeAttribution } from "../lifecycle/recall-eval/recall-eval-runtime.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot/materialize.js";
import { computeRecallEvalAggregates, type RecallEvalAggregates } from "./recall-eval-aggregates.js";
import { accumulateRecallEvalRows, type RecallEvalAccumulator } from "./recall-eval-accumulator.js";
import { buildBenchmarkMeasurementAttribution } from "../measurement/attribution.js";
import { assertMeasurementCohortBinding } from "../measurement/cohort-binding.js";
import {
  summarizeEmbeddingVectorCache,
  summarizeQueryEmbeddingCache
} from "../runner/runner-helpers.js";

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
  readonly datasetSha256: string | null;
  readonly provenanceComplete: boolean;
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
  const kpi = {
    ...buildKpiCore(accumulator, aggregates, input.collected),
    ...(input.manifest.seed_extraction_path === undefined
      ? {}
      : { seed_extraction_path: input.manifest.seed_extraction_path })
  };
  assertMeasurementCohortBinding(
    accumulator.perScenario,
    accumulator.questionDiagnostics
  );
  const candidatePoolComplete = isCandidatePoolComplete(
    accumulator,
    input.evaluatedCount
  );
  const selectionContract = resolveFullSnapshotSelection(input, accumulator);
  const measurementAttribution = buildPayloadMeasurementAttribution(
    kpi,
    candidatePoolComplete,
    input.provenanceComplete && selectionContract !== undefined
  );
  return renderRecallEvalPayload(
    input,
    kpi,
    measurementAttribution,
    selectionContract,
    accumulator.answerableCount
  );
}

function renderRecallEvalPayload(
  input: RecallEvalKpiInput,
  kpi: KpiPayload["kpi"],
  measurementAttribution: ReturnType<typeof buildPayloadMeasurementAttribution>,
  selectionContract: ReturnType<typeof resolveFullSnapshotSelection>,
  answerableCount: number
): KpiPayload {
  return {
    bench_name: "public", split: VARIANT_TO_SPLIT[input.variant],
    run_at: input.runAt.toISOString(), alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion, recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: input.embeddingProviderLabel, chat_provider: "none",
    policy_shape: input.policyShape, simulate_report: input.simulateReport,
    recall_eval_attribution: input.runtimeAttribution,
    measurement_attribution: measurementAttribution,
    ...(selectionContract === undefined
      ? {}
      : { selection_contract: selectionContract }),
    ...(input.recallWeightOverrides === undefined ? {} : {
      recall_weight_overrides: input.recallWeightOverrides.summary
    }),
    dataset: buildRecallEvalDataset(input),
    sample_size: input.sampleSize, evaluated_count: input.evaluatedCount,
    answerable_evaluated_count: answerableCount,
    harness_mode: "mcp_propose_review",
    kpi
  };
}

function buildRecallEvalDataset(input: RecallEvalKpiInput): KpiPayload["dataset"] {
  return {
    name: input.variant, size: input.sampleSize,
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    ...(input.datasetSha256 === null
      ? {}
      : { checksum_sha256: input.datasetSha256 }),
    checksum_source: input.runtimeAttribution.hydration_binding === undefined
      ? `${RECALL_EVAL_ARCHIVE_MARKER} ${input.manifest.db_filename}`
      : `${RECALL_EVAL_ARCHIVE_MARKER} external evaluator dataset binding`
  };
}

function resolveFullSnapshotSelection(
  input: RecallEvalKpiInput,
  accumulator: RecallEvalAccumulator
) {
  const slice = input.runtimeAttribution.evaluation_slice;
  const selection = input.manifest.run_provenance?.selection;
  if (slice === undefined || slice.offset !== 0 || slice.limit !== null ||
      slice.evaluated_count !== input.evaluatedCount ||
      input.evaluatedCount !== input.manifest.question_count ||
      selection === undefined) {
    return undefined;
  }
  const bindingError = findLongMemEvalSelectionBindingError({
    dataset: {
      ...(input.datasetSha256 === null
        ? {}
        : { checksum_sha256: input.datasetSha256 })
    },
    evaluated_count: input.evaluatedCount,
    selection_contract: selection,
    kpi: { per_scenario: accumulator.perScenario }
  });
  return bindingError === null ? selection : undefined;
}

function buildPayloadMeasurementAttribution(
  kpi: KpiPayload["kpi"],
  candidatePoolComplete: boolean,
  provenanceComplete: boolean
) {
  return buildBenchmarkMeasurementAttribution({
    candidatePoolComplete,
    provenanceComplete,
    abstention: kpi.quality_metrics?.abstention,
    noGoldCount: kpi.quality_metrics?.no_gold_count,
    evaluatorIdentityIssueCount:
      kpi.quality_metrics?.evaluator_identity_issue_count,
    evaluatorIdentityUnscorableCount:
      kpi.quality_metrics?.evaluator_identity_unscorable_count
  });
}

function isCandidatePoolComplete(
  accumulator: RecallEvalAccumulator,
  evaluatedCount: number
): boolean {
  return accumulator.questionDiagnostics.length === evaluatedCount &&
    accumulator.questionDiagnostics.every(
      (question) => question.candidate_pool_complete
    );
}

function buildKpiCore(
  accumulator: RecallEvalAccumulator,
  aggregates: RecallEvalAggregates,
  collected: readonly RecallEvalQuestionResult[]
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
    ...buildEmbeddingKpis(collected, accumulator.questionDiagnostics),
    per_scenario: accumulator.perScenario
  };
}

function buildEmbeddingKpis(
  collected: readonly RecallEvalQuestionResult[],
  diagnostics: RecallEvalAccumulator["questionDiagnostics"]
): Partial<KpiPayload["kpi"]> {
  const vectors = summarizeEmbeddingVectorCache(
    collected.flatMap((result) => result.embeddingWarmup ?? [])
  );
  const queries = summarizeQueryEmbeddingCache(
    collected.flatMap((result) => result.queryEmbeddingWarmup ?? [])
  );
  const provider = summarizeProviderStates(diagnostics);
  const returnedRAt5 = rAt5WithProviderReturned(diagnostics);
  return {
    provider_returned_rate: provider.provider_returned_rate,
    provider_pending_rate: provider.provider_pending_rate,
    provider_failed_rate: provider.provider_failed_rate,
    provider_not_requested_rate: provider.provider_not_requested_rate,
    ...(returnedRAt5 === undefined ? {} : { r_at_5_with_embedding_returned: returnedRAt5 }),
    ...(vectors === null ? {} : { embedding_vector_cache_ready_rate: vectors.ready_rate }),
    ...(queries === null ? {} : { query_embedding_cache_ready_rate: queries.ready_rate })
  };
}
