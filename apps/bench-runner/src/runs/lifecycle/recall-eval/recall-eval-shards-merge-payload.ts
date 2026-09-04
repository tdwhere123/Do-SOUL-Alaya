import type { KpiPayload, PerScenarioRow, QualityMetrics } from "@do-soul/alaya-eval";
import { mergeSeedExtractionPath } from "../../../cli/merge-shared.js";
import { buildMergedRates } from "../../../cli/merge/merged/merged-rates.js";
import { computeQuestionIdDigest } from "../../selection/question-manifest.js";
import type { LoadedShardArchive } from "./recall-eval-shards-merge-load.js";

export interface ScorableHits {
  readonly evaluatedCount: number;
  readonly answerableCount: number;
  readonly abstentionCount: number;
  readonly unscorableAnswerableCount: number;
  readonly hitsAt1: number;
  readonly hitsAt5: number;
  readonly hitsAt10: number;
}

export function computeScorableHits(
  perScenario: readonly PerScenarioRow[],
  diagnostics: ReadonlyMap<string, Record<string, unknown>>
): ScorableHits {
  let answerableCount = 0;
  let abstentionCount = 0;
  let unscorableAnswerableCount = 0;
  let hitsAt1 = 0;
  let hitsAt5 = 0;
  let hitsAt10 = 0;
  for (const row of perScenario) {
    const cohort = classifyBoundRow(row);
    if (cohort === "abstention") {
      abstentionCount += 1;
      continue;
    }
    if (cohort === "unscorable_answerable") {
      unscorableAnswerableCount += 1;
      continue;
    }
    answerableCount += 1;
    const diagnostic = diagnostics.get(row.id);
    assertDiagnosticHitAgrees(diagnostic, row.id, row.hit_at_5);
    if (requiredHit(hitAt(diagnostic, row, "hit_at_1"), "hit_at_1", row.id)) hitsAt1 += 1;
    if (row.hit_at_5) hitsAt5 += 1;
    if (requiredHit(hitAt(diagnostic, row, "hit_at_10"), "hit_at_10", row.id)) hitsAt10 += 1;
  }
  return {
    evaluatedCount: perScenario.length,
    answerableCount,
    abstentionCount,
    unscorableAnswerableCount,
    hitsAt1,
    hitsAt5,
    hitsAt10
  };
}

export function mergeShardPayloads(
  first: KpiPayload,
  shards: readonly LoadedShardArchive[],
  perScenario: readonly PerScenarioRow[],
  hits: ScorableHits
): KpiPayload {
  const shardPayloads = shards.map((shard) => shard.payload);
  const rates = buildMergedRates({
    answerableTotal: hits.answerableCount,
    totalHitAt1: hits.hitsAt1,
    totalHitAt5: hits.hitsAt5,
    totalHitAt10: hits.hitsAt10,
    evaluatedTotal: hits.evaluatedCount,
    perScenario,
    latencyP50Max: Math.max(...shardPayloads.map((payload) => payload.kpi.latency_ms_p50)),
    latencyP95Max: Math.max(...shardPayloads.map((payload) => payload.kpi.latency_ms_p95))
  });
  return {
    ...identityEnvelope(first, shards, perScenario),
    evaluated_count: hits.evaluatedCount,
    answerable_evaluated_count: hits.answerableCount,
    kpi: {
      r_at_1: rates.rAt1,
      r_at_5: rates.rAt5,
      r_at_10: rates.rAt10,
      r_at_5_overall: rates.rAt5,
      latency_ms_p50: rates.latencyP50,
      latency_ms_p95: rates.latencyP95,
      latency_source: rates.hasExactMergedLatency ? "exact" : "worst_shard_bound",
      // token_saved_ratio_vs_full_prompt is not recomputed from rows.
      // Omit it: unknown must not serialize as 0.
      tier_distribution: sumTiers(shardPayloads),
      degradation_reasons: sumDegrade(shardPayloads),
      seed_truncation: sumTruncation(shardPayloads),
      ...seedExtractionFields(shardPayloads),
      quality_metrics: cohortQualityMetrics(hits),
      per_scenario: [...perScenario]
    } as KpiPayload["kpi"]
  };
}

function classifyBoundRow(
  row: PerScenarioRow
): "answerable" | "abstention" | "unscorable_answerable" {
  if (row.scorable === undefined || row.measurement_cohort === undefined) {
    throw new Error(
      `recall-eval shard merge question_id '${row.id}' is not explicitly bound to a scorable cohort`
    );
  }
  if (row.measurement_cohort === "dataset_declared_abstention") {
    if (row.scorable !== false) {
      throw new Error(
        `recall-eval shard merge question_id '${row.id}' abstention cohort is not scorable=false`
      );
    }
    return "abstention";
  }
  if (row.measurement_cohort !== "answerable") {
    throw new Error(
      `recall-eval shard merge question_id '${row.id}' has unknown measurement_cohort`
    );
  }
  return row.scorable === true ? "answerable" : "unscorable_answerable";
}

function hitAt(
  diagnostic: Record<string, unknown> | undefined,
  row: PerScenarioRow,
  key: "hit_at_1" | "hit_at_10"
): unknown {
  if (typeof diagnostic?.[key] === "boolean") return diagnostic[key];
  return (row as Record<string, unknown>)[key];
}

function requiredHit(value: unknown, label: string, id: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`recall-eval shard merge missing ${label} boolean for '${id}'`);
}

function assertDiagnosticHitAgrees(
  diagnostic: Record<string, unknown> | undefined,
  id: string,
  hitAt5: boolean
): void {
  if (typeof diagnostic?.hit_at_5 !== "boolean") return;
  if (diagnostic.hit_at_5 === hitAt5) return;
  throw new Error(`recall-eval shard merge hit_at_5 disagreement for '${id}'`);
}

function identityEnvelope(
  first: KpiPayload,
  shards: readonly LoadedShardArchive[],
  perScenario: readonly PerScenarioRow[]
): Omit<KpiPayload, "evaluated_count" | "answerable_evaluated_count" | "kpi"> {
  return {
    bench_name: first.bench_name,
    split: first.split,
    run_at: first.run_at,
    alaya_commit: first.alaya_commit,
    alaya_version: first.alaya_version,
    ...(first.recall_pipeline_version === undefined
      ? {}
      : { recall_pipeline_version: first.recall_pipeline_version }),
    embedding_provider: first.embedding_provider,
    chat_provider: first.chat_provider,
    policy_shape: first.policy_shape,
    simulate_report: first.simulate_report,
    ...(first.recall_weight_overrides === undefined
      ? {}
      : { recall_weight_overrides: first.recall_weight_overrides }),
    ...(first.seed_policy === undefined ? {} : { seed_policy: first.seed_policy }),
    dataset: first.dataset,
    sample_size: first.sample_size,
    harness_mode: first.harness_mode,
    ...nonPromotableAttribution(first, shards, perScenario)
  };
}

function nonPromotableAttribution(
  first: KpiPayload,
  shards: readonly LoadedShardArchive[],
  perScenario: readonly PerScenarioRow[]
): Pick<KpiPayload, "recall_eval_attribution" | "measurement_attribution"> {
  return {
    ...(first.recall_eval_attribution === undefined
      ? {}
      : {
        recall_eval_attribution: {
          ...first.recall_eval_attribution,
          gate_eligible: false,
          ...recomputedSlice(first, shards, perScenario)
        }
      }),
    ...(first.measurement_attribution === undefined
      ? {}
      : {
        measurement_attribution: {
          ...first.measurement_attribution,
          gate_eligible: false,
          status: "ineligible" as const,
          evidence_status: "partial" as const,
          provenance_complete: false
        }
      })
  };
}

function recomputedSlice(
  first: KpiPayload,
  shards: readonly LoadedShardArchive[],
  perScenario: readonly PerScenarioRow[]
): Pick<NonNullable<KpiPayload["recall_eval_attribution"]>, "evaluation_slice"> | object {
  if (first.recall_eval_attribution?.evaluation_slice === undefined) return {};
  return {
    evaluation_slice: {
      offset: shards[0]?.plan.offset ?? 0,
      limit: perScenario.length,
      evaluated_count: perScenario.length,
      question_id_digest: computeQuestionIdDigest(perScenario.map((row) => row.id))
    }
  };
}

function seedExtractionFields(
  payloads: readonly KpiPayload[]
): Pick<KpiPayload["kpi"], "seed_extraction_path"> {
  const path = mergeSeedExtractionPath(payloads);
  return path === undefined ? {} : { seed_extraction_path: path };
}

function sumTiers(payloads: readonly KpiPayload[]): KpiPayload["kpi"]["tier_distribution"] {
  return {
    hot: sumKpi(payloads, (payload) => payload.kpi.tier_distribution.hot),
    warm: sumKpi(payloads, (payload) => payload.kpi.tier_distribution.warm),
    cold: sumKpi(payloads, (payload) => payload.kpi.tier_distribution.cold)
  };
}

function sumDegrade(payloads: readonly KpiPayload[]): KpiPayload["kpi"]["degradation_reasons"] {
  return {
    none: sumKpi(payloads, (payload) => payload.kpi.degradation_reasons.none),
    warm_cascade_engaged: sumKpi(
      payloads, (payload) => payload.kpi.degradation_reasons.warm_cascade_engaged
    ),
    cold_cascade_engaged: sumKpi(
      payloads, (payload) => payload.kpi.degradation_reasons.cold_cascade_engaged
    ),
    recall_explainability_partial: sumKpi(
      payloads, (payload) => payload.kpi.degradation_reasons.recall_explainability_partial ?? 0
    )
  };
}

function sumTruncation(payloads: readonly KpiPayload[]): KpiPayload["kpi"]["seed_truncation"] {
  return {
    seed_turns_truncated: sumKpi(
      payloads, (payload) => payload.kpi.seed_truncation.seed_turns_truncated
    ),
    answer_turns_truncated: sumKpi(
      payloads, (payload) => payload.kpi.seed_truncation.answer_turns_truncated
    ),
    seed_chars_clipped: sumKpi(
      payloads, (payload) => payload.kpi.seed_truncation.seed_chars_clipped
    )
  };
}

function sumKpi(payloads: readonly KpiPayload[], select: (payload: KpiPayload) => number): number {
  return payloads.reduce((sum, payload) => sum + select(payload), 0);
}

function cohortQualityMetrics(hits: ScorableHits): QualityMetrics {
  const nonAbstention = hits.answerableCount + hits.unscorableAnswerableCount;
  return {
    ...unrecomputableQualityZeros(hits.evaluatedCount),
    unscorable_reason_distribution: {
      ...(hits.abstentionCount === 0
        ? {}
        : { dataset_declared_abstention: hits.abstentionCount }),
      ...(hits.unscorableAnswerableCount === 0
        ? {}
        : { evaluator_identity_unscorable: hits.unscorableAnswerableCount })
    },
    measurement_cohort_counts: {
      evaluated: hits.evaluatedCount,
      non_abstention: nonAbstention,
      abstention: hits.abstentionCount,
      scorable_answerable: hits.answerableCount,
      unscorable_answerable: hits.unscorableAnswerableCount,
      hit_at_5: hits.hitsAt5,
      miss_at_5: hits.answerableCount - hits.hitsAt5
    },
    abstention: {
      schema_version: "bench-abstention.v2",
      total: hits.abstentionCount,
      scored: 0,
      unscorable: hits.abstentionCount,
      method: "fused_margin_diagnostic_only",
      calibration_status: "uncalibrated",
      gate_eligible: false
    }
  };
}

function unrecomputableQualityZeros(evaluatedCount: number): Omit<
  QualityMetrics,
  "measurement_cohort_counts" | "unscorable_reason_distribution" | "abstention"
> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: evaluatedCount,
    budget_drop_distribution: {},
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: evaluatedCount,
    no_gold_count: 0,
    no_gold_denominator: evaluatedCount,
    evidence_stream_gold_delivery_rate: 0,
    evidence_stream_gold_delivery_count: 0,
    evidence_stream_gold_delivery_denominator: 0,
    path_stream_top10_rate: 0,
    path_stream_top10_count: 0,
    path_stream_top10_denominator: 0,
    per_plane_recall_coverage: {},
    miss_taxonomy_distribution: {
      candidate_absent: 0,
      materialization_drop: 0,
      fine_assessment_drop: 0,
      budget_drop: 0,
      delivery_order_drop: 0,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 0
    },
    miss_distribution: {}
  };
}
