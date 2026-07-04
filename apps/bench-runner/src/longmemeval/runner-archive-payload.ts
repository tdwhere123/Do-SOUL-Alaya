import { RECALL_PIPELINE_VERSION } from "../shared/version.js";
import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  buildTokenEconomy,
  computeTokenSavedRatio,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { aggregateBenchTokenMetrics, assertBenchTokenEconomyContract } from "../harness/token-economy.js";
import type { BenchRecallWeightOverrides } from "../harness/recall-weight-overrides.js";
import { aggregateRecallTokenEconomy } from "./recall-token-economy.js";
import {
  buildLongMemEvalFullGoldCoverage,
  buildLongMemEvalQualityMetrics,
  rAt5WithProviderReturned,
  summarizeProviderStates
} from "./diagnostics.js";
import {
  aggregateQaVerdicts,
  buildQaDeliverySettings
} from "./qa-harness.js";
import {
  computePercentile,
  readLongMemEvalPinnedMeta,
  summarizeEmbeddingVectorCache,
  summarizeQueryEmbeddingCache
} from "./runner-helpers.js";
import type { LongMemEvalRunOptions } from "./runner.js";
import { toSeedExtractionPathKpi, type CompileSeedExtractionStats } from "./compile-seed.js";
import { toSeedFuelInventoryKpi } from "./seed-fuel-inventory-kpi.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";

const LONGMEMEVAL_SEED_POLICY = Object.freeze({
  mode: "label_independent_all_fact",
  label_independent: true,
  object_kind: "fact",
  description:
    "LongMemEval public recall evaluation seeds every haystack turn as a factual memory; has_answer labels are used only for scoring sidecars."
});

export interface LongMemEvalPayloadBuild {
  readonly payload: KpiPayload;
  readonly providerSummary: ReturnType<typeof summarizeProviderStates>;
  readonly reportUsage: {
    readonly reportsAttempted: number;
    readonly reportsUsed: number;
    readonly reportsSkipped: number;
    readonly reportUsedObjectCount: number;
  };
  readonly embeddingVectorCache: ReturnType<typeof summarizeEmbeddingVectorCache>;
  readonly queryEmbeddingCache: ReturnType<typeof summarizeQueryEmbeddingCache>;
}

export function buildLongMemEvalRunPayload(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly questionsLength: number;
  readonly windowLength: number;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly extractionStats: CompileSeedExtractionStats;
  readonly seedFuelInventory: import("@do-soul/alaya-core").SeedFuelInventory;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
}): LongMemEvalPayloadBuild {
  const rates = buildArchiveRates(input.aggregate);
  const providerSummary = summarizeProviderStates(input.aggregate.questionDiagnostics);
  const embeddingVectorCache = summarizeEmbeddingVectorCache(input.aggregate.embeddingWarmups);
  const queryEmbeddingCache = summarizeQueryEmbeddingCache(input.aggregate.queryEmbeddingWarmups);
  return {
    providerSummary,
    embeddingVectorCache,
    queryEmbeddingCache,
    reportUsage: buildReportUsage(input.aggregate),
    payload: buildPayload(input, rates, providerSummary, embeddingVectorCache, queryEmbeddingCache)
  };
}

function buildArchiveRates(aggregate: LongMemEvalRunArchiveAggregate): {
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
} {
  const n = aggregate.perScenario.length;
  return {
    rAt1: n === 0 ? 0 : aggregate.totalHitAt1 / n,
    rAt5: n === 0 ? 0 : aggregate.perScenario.filter((r) => r.hit_at_5).length / n,
    rAt10: n === 0 ? 0 : aggregate.totalHitAt10 / n,
    latencyP50: computePercentile(aggregate.latencies, 50),
    latencyP95: computePercentile(aggregate.latencies, 95)
  };
}

function buildPayload(
  input: Parameters<typeof buildLongMemEvalRunPayload>[0],
  rates: ReturnType<typeof buildArchiveRates>,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  embeddingVectorCache: ReturnType<typeof summarizeEmbeddingVectorCache>,
  queryEmbeddingCache: ReturnType<typeof summarizeQueryEmbeddingCache>
): KpiPayload {
  const tokenEconomyInput = aggregateBenchTokenMetrics(input.aggregate.tokenMetricsPerQuestion);
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
  const edgeRows = input.aggregate.edgeProposalKpiRowsPerQuestion.flat();
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeRows,
    input.aggregate.edgeProposalKpiRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(edgeRows);
  const split = variantToSplit(input.opts.variant);
  return {
    bench_name: "public",
    split,
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: input.embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: input.policyShape,
    simulate_report: input.simulateReport,
    ...(input.recallWeightOverrides === undefined
      ? {}
      : { recall_weight_overrides: input.recallWeightOverrides.summary }),
    seed_policy: LONGMEMEVAL_SEED_POLICY,
    dataset: buildDataset(input),
    sample_size: input.opts.fetchResult?.questionCount ?? input.questionsLength,
    evaluated_count: input.windowLength,
    harness_mode: "mcp_propose_review",
    kpi: buildKpi(input, rates, providerSummary, embeddingVectorCache, queryEmbeddingCache, tokenEconomyInput, edgeProposalRate, edgeProposalAutoAccept)
  };
}

function variantToSplit(variant: LongMemEvalRunOptions["variant"]): BenchSplit {
  const map: Record<LongMemEvalRunOptions["variant"], BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  return map[variant];
}

function buildDataset(input: Parameters<typeof buildLongMemEvalRunPayload>[0]): KpiPayload["dataset"] {
  const pinnedMeta = readLongMemEvalPinnedMeta(
    input.opts.variant,
    input.opts.pinnedMetaRoot
  );
  return {
    name: input.opts.variant,
    size: input.opts.fetchResult?.questionCount ?? input.questionsLength,
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    checksum_sha256: pinnedMeta.sha256,
    checksum_source: pinnedMeta.source
  };
}

function buildKpi(
  input: Parameters<typeof buildLongMemEvalRunPayload>[0],
  rates: ReturnType<typeof buildArchiveRates>,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  embeddingVectorCache: ReturnType<typeof summarizeEmbeddingVectorCache>,
  queryEmbeddingCache: ReturnType<typeof summarizeQueryEmbeddingCache>,
  tokenEconomyInput: Parameters<typeof buildTokenEconomy>[0],
  edgeProposalRate: ReturnType<typeof aggregateEdgeProposalRate>,
  edgeProposalAutoAccept: ReturnType<typeof aggregateEdgeProposalAutoAccept>
): KpiPayload["kpi"] {
  const recallTokenEconomy = aggregateRecallTokenEconomy(input.aggregate.recallTokenEconomySamples);
  const qaMetrics = buildArchiveQaMetrics(input);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(input.aggregate.questionDiagnostics);
  return {
    r_at_1: rates.rAt1,
    r_at_5: rates.rAt5,
    r_at_10: rates.rAt10,
    ...embeddingKpiFields(input, rates.rAt5, providerSummary, rAt5EmbeddingReturned, embeddingVectorCache, queryEmbeddingCache),
    latency_ms_p50: rates.latencyP50,
    latency_ms_p95: rates.latencyP95,
    latency_source: "exact",
    token_saved_ratio_vs_full_prompt: computeTokenSavedRatio(tokenEconomyInput),
    token_economy: buildTokenEconomy(tokenEconomyInput),
    ...(recallTokenEconomy === null ? {} : { recall_token_economy: recallTokenEconomy }),
    tier_distribution: { hot: input.aggregate.tierHot, warm: input.aggregate.tierWarm, cold: input.aggregate.tierCold },
    degradation_reasons: {
      none: input.aggregate.degradeNone,
      warm_cascade_engaged: input.aggregate.degradeWarm,
      cold_cascade_engaged: input.aggregate.degradeCold,
      recall_explainability_partial: input.aggregate.degradePartial
    },
    seed_truncation: {
      seed_turns_truncated: input.aggregate.truncSeedTotal,
      answer_turns_truncated: input.aggregate.truncAnswerTotal,
      seed_chars_clipped: input.aggregate.truncCharsTotal
    },
    seed_extraction_path: toSeedExtractionPathKpi(input.extractionStats),
    seed_fuel_inventory: toSeedFuelInventoryKpi(input.seedFuelInventory),
    full_gold_coverage: buildLongMemEvalFullGoldCoverage(input.aggregate.questionDiagnostics),
    quality_metrics: buildLongMemEvalQualityMetrics(input.aggregate.questionDiagnostics),
    ...(edgeProposalRate === undefined ? {} : { edge_proposal_rate: edgeProposalRate }),
    ...(edgeProposalAutoAccept === undefined ? {} : { edge_proposal_auto_accept: edgeProposalAutoAccept }),
    ...(qaMetrics === undefined ? {} : { qa_metrics: qaMetrics }),
    per_scenario: input.aggregate.perScenario
  };
}

function embeddingKpiFields(
  input: Parameters<typeof buildLongMemEvalRunPayload>[0],
  rAt5: number,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  rAt5EmbeddingReturned: number | undefined,
  embeddingVectorCache: ReturnType<typeof summarizeEmbeddingVectorCache>,
  queryEmbeddingCache: ReturnType<typeof summarizeQueryEmbeddingCache>
): Partial<KpiPayload["kpi"]> {
  if (input.opts.embeddingMode !== "env") return {};
  return {
    r_at_5_overall: rAt5,
    ...(rAt5EmbeddingReturned === undefined ? {} : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
    provider_returned_rate: providerSummary.provider_returned_rate,
    provider_pending_rate: providerSummary.provider_pending_rate,
    provider_failed_rate: providerSummary.provider_failed_rate,
    provider_not_requested_rate: providerSummary.provider_not_requested_rate,
    ...(embeddingVectorCache === null ? {} : { embedding_vector_cache_ready_rate: embeddingVectorCache.ready_rate }),
    ...(queryEmbeddingCache === null ? {} : { query_embedding_cache_ready_rate: queryEmbeddingCache.ready_rate })
  };
}

function buildArchiveQaMetrics(
  input: Parameters<typeof buildLongMemEvalRunPayload>[0]
): KpiPayload["kpi"]["qa_metrics"] | undefined {
  if (input.opts.qa === undefined || input.aggregate.qaVerdicts.length === 0) {
    return undefined;
  }
  return {
    ...aggregateQaVerdicts(input.aggregate.qaVerdicts),
    delivery_settings: buildQaDeliverySettings(),
    answer_model: input.opts.qa.answerModel,
    judge_model: input.opts.qa.judgeModel
  };
}

function buildReportUsage(aggregate: LongMemEvalRunArchiveAggregate): LongMemEvalPayloadBuild["reportUsage"] {
  return {
    reportsAttempted: aggregate.reportsAttempted,
    reportsUsed: aggregate.reportsUsed,
    reportsSkipped: aggregate.reportsSkipped,
    reportUsedObjectCount: aggregate.reportUsedObjectCount
  };
}
