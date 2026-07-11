import type { KpiPayload } from "../schema/kpi-schema.js";
import { wilsonInterval } from "../metrics/wilson-ci.js";

export function renderAbsoluteKpis(lines: string[], current: KpiPayload): void {
  pushAbsoluteKpiHeader(lines);
  pushRecallHeadlineKpis(lines, current);
  pushLatencyAndPrimaryEconomy(lines, current);
  pushPerRecallEconomy(lines, current);
  pushTierAndEmbeddingKpis(lines, current);
  pushSeedAndQualityKpis(lines, current);
  lines.push("");
}

function pushAbsoluteKpiHeader(lines: string[]): void {
  lines.push("## Absolute KPIs");
  lines.push("");
}

function pushRecallHeadlineKpis(lines: string[], current: KpiPayload): void {
  lines.push(
    `- R@1: ${formatRatio(current.kpi.r_at_1)}${ciAnnotation(current.kpi.r_at_1, current.evaluated_count)}`
  );
  lines.push(
    `- R@5: ${formatRatio(current.kpi.r_at_5)}${ciAnnotation(current.kpi.r_at_5, current.evaluated_count)}`
  );
  lines.push(
    `- R@10: ${formatRatio(current.kpi.r_at_10)}${ciAnnotation(current.kpi.r_at_10, current.evaluated_count)}`
  );
  if (
    current.kpi.r_at_5_overall !== undefined ||
    current.kpi.r_at_5_with_embedding_returned !== undefined
  ) {
    lines.push(`- Env embedding R@5 overall: ${formatMaybeRatio(current.kpi.r_at_5_overall)}`);
    lines.push(
      `- Env embedding R@5 when provider returned: ${formatMaybeRatio(current.kpi.r_at_5_with_embedding_returned)}`
    );
  }
  if (
    current.kpi.r_at_5_round_1 !== undefined ||
    current.kpi.r_at_5_round_2 !== undefined ||
    current.kpi.r_at_5_round_n !== undefined
  ) {
    lines.push(
      `- Multi-turn R@5: round1=${formatMaybeRatio(current.kpi.r_at_5_round_1)} round2=${formatMaybeRatio(current.kpi.r_at_5_round_2)} round${current.kpi.multiturn_rounds ?? "N"}=${formatMaybeRatio(current.kpi.r_at_5_round_n)}`
    );
  }
}

function pushLatencyAndPrimaryEconomy(lines: string[], current: KpiPayload): void {
  const latencyTag =
    current.kpi.latency_source === "worst_shard_bound"
      ? " (≤ worst-shard upper bound)"
      : "";
  lines.push(`- Latency p50: ${current.kpi.latency_ms_p50} ms${latencyTag}`);
  lines.push(`- Latency p95: ${current.kpi.latency_ms_p95} ms${latencyTag}`);
  lines.push(
    `- Token saved vs full-prompt baseline: ${formatRatio(current.kpi.token_saved_ratio_vs_full_prompt)}`
  );
  const rte = current.kpi.recall_token_economy;
  // Merged-shard KPI deliberately omits recall_token_economy because the
  // honest cross-shard distribution needs the raw per-recall samples
  // (only per-shard archives carry them). Surface that explicitly so a
  // reader of the merged report does not mistake the absence for an
  // instrumentation bug. see also: apps/bench-runner/src/cli.ts
  // @anchor merged-recall-token-economy.
  if (
    rte === undefined &&
    current.kpi.latency_source === "worst_shard_bound"
  ) {
    lines.push(
      "- Per-recall token economy: omitted (multi-shard mode; see per-shard archives)"
    );
  }
}

function pushPerRecallEconomy(lines: string[], current: KpiPayload): void {
  const rte = current.kpi.recall_token_economy;
  if (rte !== undefined && rte.sample_count > 0) {
    // Per-recall structural instrument (measure-only): distributions over
    // all recall calls in the run. Numbers describe
    // what the recall pipeline actually did per call; they are not
    // gates and not threshold targets. The token-unit caveat (chars/4
    // heuristic, CJK underestimated ~3-4x) lives on RecallTokenEconomy
    // in packages/core/src/recall/recall-service-types.ts.
    lines.push(
      `- Per-recall token economy (${rte.sample_count} calls, measure-only):`
    );
    pushDistributionLine(lines, "delivered_context_tokens", rte.delivered_context_tokens_estimate);
    pushDistributionLine(lines, "coarse_pool_size", rte.coarse_pool_size);
    pushDistributionLine(lines, "fine_evaluated", rte.fine_evaluated);
    pushDistributionLine(lines, "fusion_streams_with_hits", rte.fusion_streams_with_hits);
    pushDistributionLine(lines, "embedding_inference_calls", rte.embedding_inference_calls, 3);
  }
}

function pushDistributionLine(
  lines: string[],
  label: string,
  distribution: Readonly<{ mean: number; p50: number; p95: number; max: number }>,
  meanPrecision = 1
): void {
  lines.push(
    `  - ${label}: mean=${distribution.mean.toFixed(meanPrecision)} ` +
      `p50=${distribution.p50.toFixed(1)} ` +
      `p95=${distribution.p95.toFixed(1)} ` +
      `max=${distribution.max}`
  );
}

function pushTierAndEmbeddingKpis(lines: string[], current: KpiPayload): void {
  lines.push(
    `- Tier distribution: hot=${current.kpi.tier_distribution.hot} warm=${current.kpi.tier_distribution.warm} cold=${current.kpi.tier_distribution.cold}`
  );
  lines.push(
    `- Degradation reasons: none=${current.kpi.degradation_reasons.none} warm_cascade=${current.kpi.degradation_reasons.warm_cascade_engaged} cold_cascade=${current.kpi.degradation_reasons.cold_cascade_engaged} explainability_partial=${current.kpi.degradation_reasons.recall_explainability_partial}`
  );
  if (
    current.kpi.provider_returned_rate !== undefined ||
    current.kpi.provider_pending_rate !== undefined ||
    current.kpi.provider_failed_rate !== undefined ||
    current.kpi.provider_not_requested_rate !== undefined
  ) {
    lines.push(
      `- Embedding provider states: returned=${formatMaybeRatio(current.kpi.provider_returned_rate)} pending=${formatMaybeRatio(current.kpi.provider_pending_rate)} failed=${formatMaybeRatio(current.kpi.provider_failed_rate)} not_requested=${formatMaybeRatio(current.kpi.provider_not_requested_rate)}`
    );
  }
  if (current.kpi.embedding_vector_cache_ready_rate !== undefined) {
    lines.push(
      `- Embedding vector cache ready: ${formatMaybeRatio(current.kpi.embedding_vector_cache_ready_rate)}`
    );
  }
  if (current.kpi.query_embedding_cache_ready_rate !== undefined) {
    lines.push(
      `- Query embedding cache ready: ${formatMaybeRatio(current.kpi.query_embedding_cache_ready_rate)}`
    );
  }
}

function pushSeedAndQualityKpis(lines: string[], current: KpiPayload): void {
  const trunc = current.kpi.seed_truncation;
  lines.push(
    `- Seed truncation: turns=${trunc.seed_turns_truncated} answer_bearing=${trunc.answer_turns_truncated} chars_clipped=${trunc.seed_chars_clipped}`
  );
  if (trunc.answer_turns_truncated > 0) {
    lines.push(
      `  - ⚠ ${trunc.answer_turns_truncated} answer-bearing turn(s) had their content clipped at the protocol cap; recall cannot retrieve text past the cutoff.`
    );
  }
  const extractionPath = current.kpi.seed_extraction_path;
  if (extractionPath !== undefined) {
    pushExtractionPathSummary(lines, extractionPath);
  }
  if (current.kpi.quality_metrics !== undefined) {
    const metrics = current.kpi.quality_metrics;
    const taxonomy = metrics.miss_taxonomy_distribution;
    lines.push(
      `- Quality metrics: non_monotonic=${formatRatio(metrics.non_monotonic_rate)} (${metrics.non_monotonic_count}/${metrics.non_monotonic_denominator}) budget_drop_loss=${metrics.miss_distribution.budget_dropped ?? 0} budget_dropped_entries=${metrics.budget_drop_distribution.max_entries?.count ?? 0} candidate_absent=${metrics.candidate_absent_count} no_gold=${metrics.no_gold_count} miss_taxonomy=[candidate_absent=${taxonomy.candidate_absent} materialization_drop=${taxonomy.materialization_drop} budget_drop=${taxonomy.budget_drop} delivery_order_drop=${taxonomy.delivery_order_drop} answer_set_coverage_drop=${taxonomy.answer_set_coverage_drop} evaluation_or_gold_issue=${taxonomy.evaluation_or_gold_issue}] evidence_gold=${formatRatio(metrics.evidence_stream_gold_delivery_rate)} path_top10=${formatRatio(metrics.path_stream_top10_rate)}`
    );
    const abstention = metrics.abstention;
    if (abstention !== undefined && abstention.total > 0) {
      lines.push(
        `- Abstention (uncalibrated fused-margin heuristic, shared top-5 verdict, threshold=${abstention.false_confident_threshold}): ${abstention.total} questions, correct@1=${abstention.correct_at_1} correct@5=${abstention.correct_at_5} correct@10=${abstention.correct_at_10}; these compatibility counts carry the same question-level verdict and are credited to each recall@k numerator (denominator unchanged).`
      );
    }
  }
}

function pushExtractionPathSummary(
  lines: string[],
  extractionPath: NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>
): void {
  lines.push(
    `- Seed extraction path: ${extractionPath.path} ` +
      `(cache_hits=${extractionPath.cache_hits} llm_calls=${extractionPath.llm_calls} ` +
      `offline_fallbacks=${extractionPath.offline_fallbacks} ` +
      `live_failures=${extractionPath.live_extraction_failures} ` +
      `cached_failures=${extractionPath.cached_extraction_failures} ` +
      `facts=${extractionPath.facts_produced} signals_dropped=${extractionPath.signals_dropped} ` +
      `[parse_dropped=${extractionPath.parse_dropped} ` +
      `compile_overflow_dropped=${extractionPath.compile_overflow_dropped} ` +
      `candidate_absent=${extractionPath.signals_dropped_by_reason.candidate_absent} ` +
      `materialization_drop=${extractionPath.signals_dropped_by_reason.materialization_drop}])`
  );
  pushNoCredentialsFallbackWarning(lines, extractionPath.path);
  pushExtractionFailureWarning(lines, extractionPath);
  pushDroppedSignalsWarning(lines, extractionPath);
}

function pushNoCredentialsFallbackWarning(lines: string[], extractionPathKind: string): void {
  if (extractionPathKind !== "no_credentials_fallback") {
    return;
  }
  lines.push(
    "  - ⚠ This run took the no-credentials fallback: each turn was",
    "    seeded as one full-turn fact, NOT the production multi-signal",
    "    garden extraction. The keyword-rich full turn can out-score a",
    "    tight production `distilled_fact`, so this R@K is NOT comparable",
    "    to an `official_api_compile` run."
  );
}

function pushExtractionFailureWarning(
  lines: string[],
  extractionPath: NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>
): void {
  const extractionFailures =
    extractionPath.live_extraction_failures +
    extractionPath.cached_extraction_failures;
  if (extractionFailures <= 0) {
    return;
  }
  lines.push(
    `  - ⚠ ${extractionFailures} turn(s) fell back after official extraction failed ` +
      `(${extractionPath.live_extraction_failures} live/cache-miss failure(s), ` +
      `${extractionPath.cached_extraction_failures} cached raw JSON failure(s)).`
  );
}

function pushDroppedSignalsWarning(
  lines: string[],
  extractionPath: NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>
): void {
  if (extractionPath.signals_dropped <= 0) {
    return;
  }
  const drops = attributeSeedDrops(extractionPath);
  if (drops.declined > 0) {
    lines.push(
      `  - ${drops.declined} extracted signal(s) declined by governance routing ` +
        `(routed to evidence_only/deferred, not durable memory) — expected for conversational turns, not a failure.`
    );
  }
  if (drops.trulyLost > 0) {
    lines.push(
      `  - ⚠ ${drops.trulyLost} extracted signal(s) were lost before seeding ` +
        `(${drops.parseDropped} dropped by the parser as malformed / over the 64-signal cap, ` +
        `${drops.compileOverflowDropped} dropped by compile() as oversized, ` +
        `${drops.materializationDrop} failed materialization, ` +
        `${drops.batchResidual} dropped when a seed-materialization batch failed); ` +
        `a dropped answer-bearing signal inflates the miss rate.`
    );
  }
}

export interface SeedDropAttribution {
  readonly declined: number;
  readonly parseDropped: number;
  readonly compileOverflowDropped: number;
  readonly materializationDrop: number;
  readonly batchResidual: number;
  readonly trulyLost: number;
}

// candidate_absent is governance declining a signal as durable truth, not a loss;
// only parser/compile/materialization/unattributed-batch drops truly lose a signal.
export function attributeSeedDrops(
  extractionPath: NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>
): SeedDropAttribution {
  const declined = extractionPath.signals_dropped_by_reason.candidate_absent;
  const materializationDrop = extractionPath.signals_dropped_by_reason.materialization_drop;
  const batchResidual = Math.max(
    0,
    extractionPath.signals_dropped -
      extractionPath.parse_dropped -
      extractionPath.compile_overflow_dropped -
      declined -
      materializationDrop
  );
  return {
    declined,
    parseDropped: extractionPath.parse_dropped,
    compileOverflowDropped: extractionPath.compile_overflow_dropped,
    materializationDrop,
    batchResidual,
    trulyLost:
      extractionPath.parse_dropped +
      extractionPath.compile_overflow_dropped +
      materializationDrop +
      batchResidual
  };
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function formatMaybeRatio(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return formatRatio(value);
}

function ciAnnotation(ratio: number, evaluatedCount: number): string {
  if (!Number.isFinite(ratio) || evaluatedCount <= 0) {
    return "";
  }
  const successes = Math.round(ratio * evaluatedCount);
  const interval = wilsonInterval(successes, evaluatedCount);
  const halfWidthPp = ((interval.hi - interval.lo) / 2) * 100;
  return ` (95% CI ±${halfWidthPp.toFixed(2)}pp, [${(interval.lo * 100).toFixed(2)}%, ${(interval.hi * 100).toFixed(2)}%])`;
}
