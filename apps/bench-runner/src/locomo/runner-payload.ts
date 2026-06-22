import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract
} from "../harness/token-economy.js";
import type { BenchEmbeddingMode } from "../harness/daemon.js";
import {
  aggregateQaVerdicts,
  buildQaDeliverySettings
} from "../longmemeval/qa-harness.js";
import type { CompileSeedExtractionStats } from "../longmemeval/compile-seed.js";
import { toSeedExtractionPathKpi } from "../longmemeval/compile-seed.js";
import {
  buildLongMemEvalFullGoldCoverage,
  buildLongMemEvalQualityMetrics,
  rAt5WithProviderReturned,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar
} from "../longmemeval/diagnostics.js";
import { aggregateRecallTokenEconomy } from "../longmemeval/recall-token-economy.js";
import { RECALL_PIPELINE_VERSION } from "../shared/version.js";
import type { LocomoSample } from "./dataset.js";
import type { LocomoConversationAggregate } from "./runner-window.js";
import type { LocomoRunOptions } from "./runner-types.js";
import {
  computePercentile,
  resolveLocomoSampleSize,
  summarizeEmbeddingVectorCache,
  summarizeQueryEmbeddingCache
} from "./runner-utils.js";

const LOCOMO_SOURCE_URL = "https://github.com/snap-research/locomo/blob/main/data/locomo10.json";

export interface LocomoPayloadBuild {
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
}

export function logLocomoSeedExtractionStats(
  extractionStats: CompileSeedExtractionStats
): void {
  process.stdout.write(
    `[locomo compile-seed] path=${extractionStats.path} ` +
      `cache_hits=${extractionStats.cacheHits} ` +
      `llm_calls=${extractionStats.llmCalls} ` +
      `offline_fallbacks=${extractionStats.offlineFallbacks} ` +
      `facts=${extractionStats.factsProduced} ` +
      `signals_dropped=${extractionStats.signalsDropped}\n`
  );
}

export function buildLocomoPayload(input: {
  readonly opts: LocomoRunOptions;
  readonly conversations: readonly LocomoSample[];
  readonly aggregate: LocomoConversationAggregate;
  readonly runAt: Date;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly embeddingProvider: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly extractionStats: CompileSeedExtractionStats;
}): LocomoPayloadBuild {
  const rates = buildRecallRates(input.aggregate);
  const qaMetrics = buildLocomoQaMetrics(input.opts, input.aggregate);
  writeLocomoQaSummary(qaMetrics, input.aggregate);
  const summaries = buildLocomoKpiSummaries(input.aggregate);
  const payload: KpiPayload = {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: input.embeddingProvider,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: buildLocomoDataset(input),
    sample_size: resolveLocomoSampleSize(input.conversations),
    evaluated_count: input.aggregate.totalQa,
    harness_mode: "mcp_propose_review",
    kpi: buildLocomoKpi(input, rates, summaries, qaMetrics)
  };
  return {
    payload,
    diagnosticsPayload: buildLocomoDiagnosticsPayload(input, summaries)
  };
}

function buildLocomoDataset(input: {
  readonly opts: LocomoRunOptions;
  readonly conversations: readonly LocomoSample[];
}): KpiPayload["dataset"] {
  return {
    name: input.opts.variant,
    size: input.opts.fetchResult?.conversationCount ?? input.conversations.length,
    source: LOCOMO_SOURCE_URL
  };
}

function buildRecallRates(aggregate: LocomoConversationAggregate): {
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
} {
  return {
    rAt1: aggregate.totalQa === 0 ? 0 : aggregate.totalHitAt1 / aggregate.totalQa,
    rAt5: aggregate.totalQa === 0 ? 0 : aggregate.totalHitAt5 / aggregate.totalQa,
    rAt10: aggregate.totalQa === 0 ? 0 : aggregate.totalHitAt10 / aggregate.totalQa
  };
}

function buildLocomoQaMetrics(
  opts: LocomoRunOptions,
  aggregate: LocomoConversationAggregate
) {
  const allQaVerdicts = aggregate.conversationResults.flatMap(
    (result) => result.qaVerdicts
  );
  if (opts.qa === undefined || allQaVerdicts.length === 0) return undefined;
  return {
    ...aggregateQaVerdicts(allQaVerdicts),
    delivery_settings: buildQaDeliverySettings(),
    answer_model: opts.qa.answerModel ?? "unknown",
    judge_model: opts.qa.judgeModel ?? opts.qa.answerModel ?? "unknown"
  };
}

function writeLocomoQaSummary(
  qaMetrics: ReturnType<typeof buildLocomoQaMetrics>,
  aggregate: LocomoConversationAggregate
): void {
  const allQaVerdicts = aggregate.conversationResults.flatMap(
    (result) => result.qaVerdicts
  );
  if (allQaVerdicts.length === 0) return;
  process.stdout.write(
    `LoCoMo QA accuracy=${((qaMetrics?.qa_accuracy ?? 0) * 100).toFixed(1)}% ` +
      `(${qaMetrics?.qa_correct ?? 0}/${qaMetrics?.qa_total ?? 0})\n`
  );
  for (const [type, tally] of Object.entries(qaMetrics?.qa_by_type ?? {})) {
    process.stdout.write(`  ${type}: ${tally.correct}/${tally.total}\n`);
  }
  writeLocomoQaCategorySummary(aggregate);
}

function writeLocomoQaCategorySummary(
  aggregate: LocomoConversationAggregate
): void {
  const byCat = buildLocomoQaCategorySummary(aggregate);
  for (const cat of [...byCat.keys()].sort((a, b) => a - b)) {
    const tally = byCat.get(cat)!;
    process.stdout.write(
      `  category ${cat}: ${tally.correct}/${tally.total} = ` +
        `${((100 * tally.correct) / tally.total).toFixed(1)}%\n`
    );
  }
}

function buildLocomoQaCategorySummary(
  aggregate: LocomoConversationAggregate
): Map<number, { correct: number; total: number }> {
  const byCat = new Map<number, { correct: number; total: number }>();
  for (const row of aggregate.conversationResults.flatMap((r) => r.qaCategoryRows)) {
    const tally = byCat.get(row.category) ?? { correct: 0, total: 0 };
    tally.total += 1;
    if (row.correct) tally.correct += 1;
    byCat.set(row.category, tally);
  }
  return byCat;
}

function buildLocomoKpiSummaries(aggregate: LocomoConversationAggregate) {
  const tokenEconomyInput = aggregateBenchTokenMetrics(
    aggregate.conversationResults.map((result) => result.tokenMetrics)
  );
  assertBenchTokenEconomyContract("public-locomo", tokenEconomyInput);
  return {
    providerStateSummary: summarizeProviderStates(aggregate.questionDiagnostics),
    rAt5EmbeddingReturned: rAt5WithProviderReturned(aggregate.questionDiagnostics),
    embeddingVectorCache: summarizeEmbeddingVectorCache(
      aggregate.conversationResults.flatMap((result) =>
        result.embeddingWarmup === null ? [] : [result.embeddingWarmup]
      )
    ),
    queryEmbeddingCache: summarizeQueryEmbeddingCache(
      aggregate.conversationResults.flatMap((result) =>
        result.queryEmbeddingWarmup === null ? [] : [result.queryEmbeddingWarmup]
      )
    ),
    recallTokenEconomy: aggregateRecallTokenEconomy(
      aggregate.conversationResults.flatMap((result) => result.recallTokenEconomySamples)
    ),
    tokenEconomy: buildTokenEconomy(tokenEconomyInput),
    tokenSavedRatio: computeTokenSavedRatio(tokenEconomyInput)
  };
}

function buildLocomoKpi(
  input: Parameters<typeof buildLocomoPayload>[0],
  rates: ReturnType<typeof buildRecallRates>,
  summaries: ReturnType<typeof buildLocomoKpiSummaries>,
  qaMetrics: ReturnType<typeof buildLocomoQaMetrics>
): KpiPayload["kpi"] {
  return {
    r_at_1: rates.rAt1,
    r_at_5: rates.rAt5,
    r_at_10: rates.rAt10,
    ...buildProviderKpi(summaries),
    ...buildEmbeddingCacheKpi(summaries),
    latency_ms_p50: computePercentile(input.aggregate.latencies, 50),
    latency_ms_p95: computePercentile(input.aggregate.latencies, 95),
    latency_source: "exact",
    token_saved_ratio_vs_full_prompt: summaries.tokenSavedRatio,
    token_economy: summaries.tokenEconomy,
    seed_extraction_path: toSeedExtractionPathKpi(input.extractionStats),
    ...(summaries.recallTokenEconomy === null
      ? {}
      : { recall_token_economy: summaries.recallTokenEconomy }),
    tier_distribution: buildTierDistribution(input.aggregate),
    degradation_reasons: buildLocomoDegradationReasons(input.aggregate.totalQa),
    ...(qaMetrics === undefined ? {} : { qa_metrics: qaMetrics }),
    seed_truncation: {
      seed_turns_truncated: 0,
      answer_turns_truncated: 0,
      seed_chars_clipped: 0
    },
    full_gold_coverage: buildLongMemEvalFullGoldCoverage(input.aggregate.questionDiagnostics),
    quality_metrics: buildLongMemEvalQualityMetrics(input.aggregate.questionDiagnostics),
    per_scenario: input.aggregate.perScenario
  };
}

function buildProviderKpi(summaries: ReturnType<typeof buildLocomoKpiSummaries>) {
  return {
    ...(summaries.rAt5EmbeddingReturned === undefined
      ? {}
      : { r_at_5_with_embedding_returned: summaries.rAt5EmbeddingReturned }),
    provider_returned_rate: summaries.providerStateSummary.provider_returned_rate,
    provider_pending_rate: summaries.providerStateSummary.provider_pending_rate,
    provider_failed_rate: summaries.providerStateSummary.provider_failed_rate,
    provider_not_requested_rate: summaries.providerStateSummary.provider_not_requested_rate
  };
}

function buildEmbeddingCacheKpi(
  summaries: ReturnType<typeof buildLocomoKpiSummaries>
) {
  return {
    ...(summaries.embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache_ready_rate: summaries.embeddingVectorCache.ready_rate }),
    ...(summaries.queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache_ready_rate: summaries.queryEmbeddingCache.ready_rate })
  };
}

function buildTierDistribution(aggregate: LocomoConversationAggregate) {
  return {
    hot: aggregate.tierHot,
    warm: aggregate.tierWarm,
    cold: aggregate.tierCold
  };
}

function buildLocomoDegradationReasons(totalQa: number) {
  return {
    none: totalQa,
    warm_cascade_engaged: 0,
    cold_cascade_engaged: 0,
    recall_explainability_partial: 0
  };
}

function buildLocomoDiagnosticsPayload(
  input: Parameters<typeof buildLocomoPayload>[0],
  summaries: ReturnType<typeof buildLocomoKpiSummaries>
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    embedding_provider: input.embeddingProvider,
    embedding_mode: input.embeddingMode,
    ...(summaries.embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: summaries.embeddingVectorCache }),
    ...(summaries.queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: summaries.queryEmbeddingCache }),
    provider_state_summary: summaries.providerStateSummary,
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(
      input.aggregate.questionDiagnostics
    ),
    questions: input.aggregate.questionDiagnostics
  };
}
