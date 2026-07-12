import type { QualityMetrics } from "@do-soul/alaya-eval";
import { buildPerPlaneRecallCoverage, ratio } from "../longmemeval/diagnostics-quality-helpers.js";
import { createEmptyMissTaxonomyDistribution } from "../longmemeval/diagnostics-miss-taxonomy.js";
import {
  accumulateMeasurementAccounting,
  buildMeasurementAccounting,
  createMeasurementAccountingState,
  type MeasurementAccountingState
} from "./merge/measurement-accounting.js";
import { accumulateCoreCounters } from "./merge/quality-core-counters.js";
import { accumulateDistributions } from "./merge/quality-distributions.js";

type BudgetDropEntry = QualityMetrics["budget_drop_distribution"][string];
type GoldRankBuckets = NonNullable<QualityMetrics["gold_rank_buckets"]>;
type TopDistractorBreakdown = NonNullable<QualityMetrics["top_distractor_breakdown"]>;
type ObjectKindDelivery = NonNullable<QualityMetrics["object_kind_delivery"]>;
type GoldFacetSeparation = Omit<NonNullable<QualityMetrics["gold_facet_separation"]>, "gold_dimension_counts">;
type PerGoldRankBuckets = NonNullable<QualityMetrics["per_gold_rank_buckets"]>;
type PerGoldDisplacedBy = NonNullable<QualityMetrics["per_gold_displaced_by"]>;
type MissTaxonomyDistribution = QualityMetrics["miss_taxonomy_distribution"];

export interface MergeQualityMetricsState {
  readonly budgetCounts: Map<string, BudgetDropEntry>;
  readonly missDistribution: Record<string, number>;
  readonly missTaxonomyDistribution: MissTaxonomyDistribution;
  readonly measurementAccounting: MeasurementAccountingState;
  readonly planeGoldCounts: Map<string, number>;
  readonly planeHitAt5Counts: Map<string, number>;
  readonly goldRankBuckets: GoldRankBuckets;
  readonly topDistractorBreakdown: TopDistractorBreakdown;
  readonly objectKindDelivery: ObjectKindDelivery;
  readonly goldFacetSeparation: GoldFacetSeparation;
  readonly goldDimensionCounts: Record<string, number>;
  readonly perGoldRankBuckets: PerGoldRankBuckets;
  readonly perGoldDisplacedBy: PerGoldDisplacedBy;
  readonly optional: MergeQualityOptionalPresence;
  nonMonotonicCount: number;
  nonMonotonicDenominator: number;
  highLexicalDemotedCount: number;
  highLexicalDemotedDenominator: number;
  candidateAbsentCount: number;
  candidateAbsentDenominator: number;
  noGoldCount: number;
  noGoldDenominator: number;
  evaluatorIdentityIssueCount: number;
  evaluatorIdentityIssueDenominator: number;
  evaluatorIdentityUnscorableCount: number;
  evaluatorIdentityUnscorableDenominator: number;
  evidenceStreamGoldDeliveryCount: number;
  evidenceStreamGoldDeliveryDenominator: number;
  pathStreamTop10Count: number;
  pathStreamTop10Denominator: number;
  cohortDeliveredPlaneCount: number;
  cohortGoldSourcePlaneCount: number;
  cohortGoldFirstAdmittedCount: number;
  cohortGoldWinningAdmissionCount: number;
  cohortGoldHitAt5Count: number;
  pathFaninGoldSourceCount: number;
  pathFaninGoldHitAt5Count: number;
  graphFaninGoldSourceCount: number;
  graphFaninGoldHitAt5Count: number;
  pathPrimaryGoldHitAt5Count: number;
  graphOnlyGoldHitAt5Count: number;
}

interface MergeQualityOptionalPresence {
  cohortAttribution: boolean;
  pathVsGraphFanin: boolean;
  goldRankBuckets: boolean;
  topDistractor: boolean;
  objectKindDelivery: boolean;
  goldFacet: boolean;
  perGoldRankBuckets: boolean;
  perGoldDisplacedBy: boolean;
}

export function createMergeQualityMetricsState(): MergeQualityMetricsState {
  return {
    budgetCounts: new Map(),
    missDistribution: {},
    missTaxonomyDistribution: createEmptyMissTaxonomyDistribution(),
    measurementAccounting: createMeasurementAccountingState(),
    planeGoldCounts: new Map(),
    planeHitAt5Counts: new Map(),
    goldRankBuckets: emptyRankTally(),
    topDistractorBreakdown: emptyDistractorTally(),
    objectKindDelivery: { memory_entry: 0, synthesis_capsule: 0, total_delivered: 0 },
    goldFacetSeparation: { separable: 0, overlapping: 0, indeterminate: 0 },
    goldDimensionCounts: {},
    perGoldRankBuckets: {
      gold_ordinal_0: emptyRankTally(),
      gold_ordinal_1plus: emptyRankTally()
    },
    perGoldDisplacedBy: emptyDistractorTally(),
    optional: createOptionalPresence(),
    ...emptyCoreCounters()
  };
}

export function accumulateMergedQualityMetric(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  accumulatePlaneCoverage(state, metric);
  accumulateCoreCounters(state, metric);
  accumulateMeasurementAccounting(state.measurementAccounting, metric);
  accumulateDistributions(state, metric);
  accumulateOptionalAttribution(state, metric);
  accumulateOptionalBreakdowns(state, metric);
}

export function buildMergedQualityMetrics(
  state: MergeQualityMetricsState
): QualityMetrics {
  return {
    schema_version: "bench-quality-metrics.v1",
    ...buildCoreQualityMetrics(state),
    ...buildStreamQualityMetrics(state),
    ...buildOptionalAttributionBlocks(state),
    ...buildOptionalBreakdownBlocks(state),
    ...buildMeasurementAccounting(state.measurementAccounting),
    miss_taxonomy_distribution: state.missTaxonomyDistribution,
    miss_distribution: state.missDistribution
  };
}

function createOptionalPresence(): MergeQualityOptionalPresence {
  return {
    cohortAttribution: false,
    pathVsGraphFanin: false,
    goldRankBuckets: false,
    topDistractor: false,
    objectKindDelivery: false,
    goldFacet: false,
    perGoldRankBuckets: false,
    perGoldDisplacedBy: false
  };
}

function emptyCoreCounters() {
  return {
    nonMonotonicCount: 0,
    nonMonotonicDenominator: 0,
    highLexicalDemotedCount: 0,
    highLexicalDemotedDenominator: 0,
    candidateAbsentCount: 0,
    candidateAbsentDenominator: 0,
    noGoldCount: 0,
    noGoldDenominator: 0,
    evaluatorIdentityIssueCount: 0,
    evaluatorIdentityIssueDenominator: 0,
    evaluatorIdentityUnscorableCount: 0,
    evaluatorIdentityUnscorableDenominator: 0,
    evidenceStreamGoldDeliveryCount: 0,
    evidenceStreamGoldDeliveryDenominator: 0,
    pathStreamTop10Count: 0,
    pathStreamTop10Denominator: 0,
    cohortDeliveredPlaneCount: 0,
    cohortGoldSourcePlaneCount: 0,
    cohortGoldFirstAdmittedCount: 0,
    cohortGoldWinningAdmissionCount: 0,
    cohortGoldHitAt5Count: 0,
    pathFaninGoldSourceCount: 0,
    pathFaninGoldHitAt5Count: 0,
    graphFaninGoldSourceCount: 0,
    graphFaninGoldHitAt5Count: 0,
    pathPrimaryGoldHitAt5Count: 0,
    graphOnlyGoldHitAt5Count: 0
  };
}

function accumulatePlaneCoverage(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  for (const [plane, entry] of Object.entries(metric.per_plane_recall_coverage)) {
    state.planeGoldCounts.set(
      plane,
      (state.planeGoldCounts.get(plane) ?? 0) + entry.gold_count
    );
    state.planeHitAt5Counts.set(
      plane,
      (state.planeHitAt5Counts.get(plane) ?? 0) + entry.hit_at_5_count
    );
  }
}

function accumulateOptionalAttribution(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  if (metric.cohort_attribution !== undefined) {
    state.optional.cohortAttribution = true;
    state.cohortDeliveredPlaneCount += metric.cohort_attribution.delivered_plane_count;
    state.cohortGoldSourcePlaneCount += metric.cohort_attribution.gold_source_plane_count;
    state.cohortGoldFirstAdmittedCount +=
      metric.cohort_attribution.gold_first_admitted_count;
    state.cohortGoldWinningAdmissionCount +=
      metric.cohort_attribution.gold_winning_admission_count;
    state.cohortGoldHitAt5Count += metric.cohort_attribution.hit_at_5_count;
  }
  if (metric.path_vs_graph_fanin !== undefined) {
    state.optional.pathVsGraphFanin = true;
    accumulatePathVsGraphFanin(state, metric.path_vs_graph_fanin);
  }
}

function accumulatePathVsGraphFanin(
  state: MergeQualityMetricsState,
  fanin: NonNullable<QualityMetrics["path_vs_graph_fanin"]>
): void {
  state.pathFaninGoldSourceCount += fanin.path_gold_source_count;
  state.pathFaninGoldHitAt5Count += fanin.path_gold_hit_at_5_count;
  state.graphFaninGoldSourceCount += fanin.graph_gold_source_count;
  state.graphFaninGoldHitAt5Count += fanin.graph_gold_hit_at_5_count;
  state.pathPrimaryGoldHitAt5Count += fanin.path_primary_hit_at_5_count;
  state.graphOnlyGoldHitAt5Count += fanin.graph_only_hit_at_5_count;
}

function accumulateOptionalBreakdowns(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  accumulateOptionalRecord(metric.gold_rank_buckets, state.goldRankBuckets, (present) => {
    state.optional.goldRankBuckets = present;
  });
  accumulateOptionalRecord(metric.top_distractor_breakdown, state.topDistractorBreakdown, (present) => {
    state.optional.topDistractor = present;
  });
  accumulateObjectKindDelivery(state, metric.object_kind_delivery);
  accumulateGoldFacet(state, metric.gold_facet_separation);
  accumulatePerGoldRankBuckets(state, metric.per_gold_rank_buckets);
  accumulateOptionalRecord(metric.per_gold_displaced_by, state.perGoldDisplacedBy, (present) => {
    state.optional.perGoldDisplacedBy = present;
  });
}

function accumulateObjectKindDelivery(
  state: MergeQualityMetricsState,
  delivery: QualityMetrics["object_kind_delivery"]
): void {
  if (delivery === undefined) return;
  state.optional.objectKindDelivery = true;
  accumulateRecord(state.objectKindDelivery, delivery);
}

function accumulateGoldFacet(
  state: MergeQualityMetricsState,
  facet: QualityMetrics["gold_facet_separation"]
): void {
  if (facet === undefined) return;
  state.optional.goldFacet = true;
  state.goldFacetSeparation.separable += facet.separable;
  state.goldFacetSeparation.overlapping += facet.overlapping;
  state.goldFacetSeparation.indeterminate += facet.indeterminate;
  for (const [dim, count] of Object.entries(facet.gold_dimension_counts)) {
    state.goldDimensionCounts[dim] = (state.goldDimensionCounts[dim] ?? 0) + count;
  }
}

function accumulatePerGoldRankBuckets(
  state: MergeQualityMetricsState,
  buckets: QualityMetrics["per_gold_rank_buckets"]
): void {
  if (buckets === undefined) return;
  state.optional.perGoldRankBuckets = true;
  accumulateRecord(state.perGoldRankBuckets.gold_ordinal_0, buckets.gold_ordinal_0);
  accumulateRecord(
    state.perGoldRankBuckets.gold_ordinal_1plus,
    buckets.gold_ordinal_1plus
  );
}

function buildCoreQualityMetrics(
  state: MergeQualityMetricsState
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
    non_monotonic_rate: ratio(state.nonMonotonicCount, state.nonMonotonicDenominator),
    non_monotonic_count: state.nonMonotonicCount,
    non_monotonic_denominator: state.nonMonotonicDenominator,
    budget_drop_distribution: buildBudgetDropDistribution(state),
    high_lexical_demoted_rate: ratio(
      state.highLexicalDemotedCount,
      state.highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: state.highLexicalDemotedCount,
    high_lexical_demoted_denominator: state.highLexicalDemotedDenominator,
    candidate_absent_count: state.candidateAbsentCount,
    candidate_absent_denominator: state.candidateAbsentDenominator,
    no_gold_count: state.noGoldCount,
    no_gold_denominator: state.noGoldDenominator,
    evaluator_identity_issue_count: state.evaluatorIdentityIssueCount,
    evaluator_identity_issue_denominator: state.evaluatorIdentityIssueDenominator,
    evaluator_identity_unscorable_count: state.evaluatorIdentityUnscorableCount,
    evaluator_identity_unscorable_denominator:
      state.evaluatorIdentityUnscorableDenominator
  };
}

function buildBudgetDropDistribution(
  state: MergeQualityMetricsState
): QualityMetrics["budget_drop_distribution"] {
  return Object.fromEntries(
    [...state.budgetCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(
      ([key, entry]) => [
        key,
        {
          count: entry.count,
          share: ratio(entry.count, entry.denominator),
          denominator: entry.denominator
        }
      ]
    )
  );
}

function buildStreamQualityMetrics(
  state: MergeQualityMetricsState
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
    path_stream_top10_rate: ratio(state.pathStreamTop10Count, state.pathStreamTop10Denominator),
    path_stream_top10_count: state.pathStreamTop10Count,
    path_stream_top10_denominator: state.pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      state.planeGoldCounts,
      state.planeHitAt5Counts
    )
  };
}

function buildOptionalAttributionBlocks(
  state: MergeQualityMetricsState
): Partial<Pick<QualityMetrics, "cohort_attribution" | "path_vs_graph_fanin">> {
  return {
    ...(state.optional.cohortAttribution
      ? { cohort_attribution: buildCohortAttribution(state) }
      : {}),
    ...(state.optional.pathVsGraphFanin
      ? { path_vs_graph_fanin: buildPathVsGraphFanin(state) }
      : {})
  };
}

function buildCohortAttribution(
  state: MergeQualityMetricsState
): QualityMetrics["cohort_attribution"] {
  return {
    delivered_plane_count: state.cohortDeliveredPlaneCount,
    gold_source_plane_count: state.cohortGoldSourcePlaneCount,
    gold_first_admitted_count: state.cohortGoldFirstAdmittedCount,
    gold_winning_admission_count: state.cohortGoldWinningAdmissionCount,
    hit_at_5_count: state.cohortGoldHitAt5Count,
    hit_at_5_rate: ratio(state.cohortGoldHitAt5Count, state.cohortGoldSourcePlaneCount)
  };
}

function buildPathVsGraphFanin(
  state: MergeQualityMetricsState
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

function buildOptionalBreakdownBlocks(
  state: MergeQualityMetricsState
): Partial<
  Pick<
    QualityMetrics,
    | "gold_rank_buckets"
    | "top_distractor_breakdown"
    | "object_kind_delivery"
    | "gold_facet_separation"
    | "per_gold_rank_buckets"
    | "per_gold_displaced_by"
  >
> {
  return {
    ...(state.optional.goldRankBuckets ? { gold_rank_buckets: state.goldRankBuckets } : {}),
    ...(state.optional.topDistractor
      ? { top_distractor_breakdown: state.topDistractorBreakdown }
      : {}),
    ...(state.optional.objectKindDelivery
      ? { object_kind_delivery: state.objectKindDelivery }
      : {}),
    ...(state.optional.goldFacet ? { gold_facet_separation: buildGoldFacet(state) } : {}),
    ...(state.optional.perGoldRankBuckets
      ? { per_gold_rank_buckets: state.perGoldRankBuckets }
      : {}),
    ...(state.optional.perGoldDisplacedBy
      ? { per_gold_displaced_by: state.perGoldDisplacedBy }
      : {})
  };
}

function buildGoldFacet(
  state: MergeQualityMetricsState
): QualityMetrics["gold_facet_separation"] {
  return {
    ...state.goldFacetSeparation,
    gold_dimension_counts: state.goldDimensionCounts
  };
}

function emptyRankTally(): GoldRankBuckets {
  return {
    delivered_top5: 0,
    pre_budget_6_10: 0,
    pre_budget_11_25: 0,
    pre_budget_26_50: 0,
    pre_budget_51_100: 0,
    pre_budget_gt_100: 0,
    candidate_absent: 0
  };
}

function emptyDistractorTally(): TopDistractorBreakdown {
  return {
    existing_score_dominant: 0,
    synthesis_reserved: 0,
    source_proximity_local_only: 0,
    path_or_graph_dominant: 0,
    lexical_topic_neighbor: 0,
    unknown: 0
  };
}

function accumulateOptionalRecord<K extends string>(
  source: Record<K, number> | undefined,
  target: Record<K, number>,
  setPresent: (present: true) => void
): void {
  if (source === undefined) return;
  setPresent(true);
  accumulateRecord(target, source);
}

function accumulateRecord<K extends string>(
  target: Record<K, number>,
  source: Record<K, number>
): void {
  for (const key of Object.keys(target) as K[]) {
    target[key] += source[key];
  }
}
