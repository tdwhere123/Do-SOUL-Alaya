import type { QualityMetrics } from "@do-soul/alaya-eval";
import {
  buildPerPlaneRecallCoverage,
  ratio
} from "../quality/diagnostics-quality-helpers.js";
import type { QualityMetricsState } from "../quality/diagnostics-quality-state.js";

export function buildQualityMetricsFromState(
  state: QualityMetricsState,
  questionDenominator: number,
  evaluatorIdentityDenominator: number
): QualityMetrics {
  if (!state.budgetDropCounts.has("max_entries")) {
    state.budgetDropCounts.set("max_entries", 0);
  }
  return {
    schema_version: "bench-quality-metrics.v1",
    ...buildOrderAndBudgetMetrics(
      state,
      questionDenominator,
      evaluatorIdentityDenominator
    ),
    ...buildStreamAndCoverageMetrics(state),
    cohort_attribution: buildCohortAttribution(state),
    path_vs_graph_fanin: buildPathVsGraphFanin(state),
    abstention: buildAbstentionMetrics(state),
    gold_rank_buckets: state.goldRankBuckets,
    top_distractor_breakdown: state.topDistractorBreakdown,
    object_kind_delivery: state.objectKindDelivery,
    gold_facet_separation: {
      ...state.goldFacetSeparation,
      gold_dimension_counts: state.goldDimensionCounts
    },
    per_gold_rank_buckets: state.perGoldRankBuckets,
    per_gold_displaced_by: state.perGoldDisplacedBy,
    miss_taxonomy_distribution: state.missTaxonomyDistribution,
    unscorable_reason_distribution: state.unscorableReasonDistribution,
    measurement_cohort_counts: state.measurementCohortCounts,
    miss_distribution: state.missDistribution
  };
}

function buildOrderAndBudgetMetrics(
  state: QualityMetricsState,
  questionDenominator: number,
  evaluatorIdentityDenominator: number
): Pick<
  QualityMetrics,
  | "non_monotonic_rate"
  | "non_monotonic_count"
  | "non_monotonic_denominator"
  | "budget_drop_distribution"
  | "high_lexical_demoted_rate"
  | "high_lexical_demoted_count"
  | "high_lexical_demoted_denominator"
  | "candidate_absent_count"
  | "candidate_absent_denominator"
  | "no_gold_count"
  | "no_gold_denominator"
  | "evaluator_identity_issue_count"
  | "evaluator_identity_issue_denominator"
  | "evaluator_identity_unscorable_count"
  | "evaluator_identity_unscorable_denominator"
> {
  return {
    non_monotonic_rate: ratio(state.nonMonotonicCount, questionDenominator),
    non_monotonic_count: state.nonMonotonicCount,
    non_monotonic_denominator: questionDenominator,
    budget_drop_distribution: buildBudgetDropDistribution(state),
    high_lexical_demoted_rate: ratio(
      state.highLexicalDemotedCount,
      state.highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: state.highLexicalDemotedCount,
    high_lexical_demoted_denominator: state.highLexicalDemotedDenominator,
    candidate_absent_count: state.candidateAbsentCount,
    candidate_absent_denominator: questionDenominator,
    no_gold_count: state.noGoldCount,
    no_gold_denominator: questionDenominator,
    evaluator_identity_issue_count: state.evaluatorIdentityIssueCount,
    evaluator_identity_issue_denominator: evaluatorIdentityDenominator,
    evaluator_identity_unscorable_count: state.evaluatorIdentityUnscorableCount,
    evaluator_identity_unscorable_denominator: evaluatorIdentityDenominator
  };
}

function buildBudgetDropDistribution(
  state: QualityMetricsState
): QualityMetrics["budget_drop_distribution"] {
  return Object.fromEntries(
    [...state.budgetDropCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => [
        key,
        {
          count,
          share: ratio(count, state.budgetDropDenominator),
          denominator: state.budgetDropDenominator
        }
      ])
  );
}

function buildStreamAndCoverageMetrics(
  state: QualityMetricsState
): Pick<
  QualityMetrics,
  | "evidence_stream_gold_delivery_rate"
  | "evidence_stream_gold_delivery_count"
  | "evidence_stream_gold_delivery_denominator"
  | "path_stream_top10_rate"
  | "path_stream_top10_count"
  | "path_stream_top10_denominator"
  | "per_plane_recall_coverage"
> {
  return {
    evidence_stream_gold_delivery_rate: ratio(
      state.evidenceStreamGoldDeliveryCount,
      state.evidenceStreamGoldDeliveryDenominator
    ),
    evidence_stream_gold_delivery_count: state.evidenceStreamGoldDeliveryCount,
    evidence_stream_gold_delivery_denominator:
      state.evidenceStreamGoldDeliveryDenominator,
    path_stream_top10_rate: ratio(
      state.pathStreamTop10Count,
      state.pathStreamTop10Denominator
    ),
    path_stream_top10_count: state.pathStreamTop10Count,
    path_stream_top10_denominator: state.pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      state.planeGoldCounts,
      state.planeHitAt5Counts
    )
  };
}

function buildCohortAttribution(
  state: QualityMetricsState
): QualityMetrics["cohort_attribution"] {
  return {
    delivered_plane_count: state.cohortDeliveredPlaneCount,
    gold_source_plane_count: state.cohortGoldSourcePlaneCount,
    gold_first_admitted_count: state.cohortGoldFirstAdmittedCount,
    gold_winning_admission_count: state.cohortGoldWinningAdmissionCount,
    hit_at_5_count: state.cohortGoldHitAt5Count,
    hit_at_5_rate: ratio(
      state.cohortGoldHitAt5Count,
      state.cohortGoldSourcePlaneCount
    )
  };
}

function buildPathVsGraphFanin(
  state: QualityMetricsState
): QualityMetrics["path_vs_graph_fanin"] {
  return {
    path_gold_source_count: state.pathFaninGoldSourceCount,
    path_gold_hit_at_5_count: state.pathFaninGoldHitAt5Count,
    path_gold_hit_at_5_rate: ratio(
      state.pathFaninGoldHitAt5Count,
      state.pathFaninGoldSourceCount
    ),
    graph_gold_source_count: state.graphFaninGoldSourceCount,
    graph_gold_hit_at_5_count: state.graphFaninGoldHitAt5Count,
    graph_gold_hit_at_5_rate: ratio(
      state.graphFaninGoldHitAt5Count,
      state.graphFaninGoldSourceCount
    ),
    path_primary_hit_at_5_count: state.pathPrimaryGoldHitAt5Count,
    graph_only_hit_at_5_count: state.graphOnlyGoldHitAt5Count
  };
}

function buildAbstentionMetrics(
  state: QualityMetricsState
): QualityMetrics["abstention"] {
  return {
    schema_version: "bench-abstention.v2",
    total: state.abstentionTotal,
    scored: 0,
    unscorable: state.abstentionUnscorable,
    method: "fused_margin_diagnostic_only",
    calibration_status: "uncalibrated",
    gate_eligible: false
  };
}
