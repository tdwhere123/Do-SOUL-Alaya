import type { KpiPayload, QualityMetrics } from "@do-soul/alaya-eval";
import { buildPerPlaneRecallCoverage } from "../longmemeval/diagnostics.js";

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function mergeQualityMetrics(
  shards: readonly KpiPayload[]
): QualityMetrics | undefined {
  if (shards.length === 0) return undefined;
  const metrics = shards.map((shard) => shard.kpi.quality_metrics);
  if (metrics.every((item) => item === undefined)) return undefined;
  if (metrics.some((item) => item === undefined)) return undefined;

  let nonMonotonicCount = 0;
  let nonMonotonicDenominator = 0;
  let highLexicalDemotedCount = 0;
  let highLexicalDemotedDenominator = 0;
  let candidateAbsentCount = 0;
  let candidateAbsentDenominator = 0;
  let noGoldCount = 0;
  let noGoldDenominator = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  const budgetCounts = new Map<string, { count: number; denominator: number }>();
  const missDistribution: Record<string, number> = {};
  const planeGoldCounts = new Map<string, number>();
  const planeHitAt5Counts = new Map<string, number>();
  let anyCohortAttribution = false;
  let cohortDeliveredPlaneCount = 0;
  let cohortGoldSourcePlaneCount = 0;
  let cohortGoldFirstAdmittedCount = 0;
  let cohortGoldWinningAdmissionCount = 0;
  let cohortGoldHitAt5Count = 0;
  let anyPathVsGraphFanin = false;
  let pathFaninGoldSourceCount = 0;
  let pathFaninGoldHitAt5Count = 0;
  let graphFaninGoldSourceCount = 0;
  let graphFaninGoldHitAt5Count = 0;
  let pathPrimaryGoldHitAt5Count = 0;
  let graphOnlyGoldHitAt5Count = 0;
  // invariant: every additive count block a shard carries is summed here, else
  // merged kpi.json silently drops it.
  let anyGoldRankBuckets = false;
  const goldRankBucketTotals = emptyRankTally();
  let anyTopDistractor = false;
  const topDistractorTotals = emptyDistractorTally();
  let anyObjectKindDelivery = false;
  const objectKindDeliveryTotals = {
    memory_entry: 0,
    synthesis_capsule: 0,
    total_delivered: 0
  };
  let anyGoldFacet = false;
  const goldFacetTotals = { separable: 0, overlapping: 0, indeterminate: 0 };
  const goldDimensionCounts: Record<string, number> = {};
  let anyPerGoldRankBuckets = false;
  const perGoldRankBucketTotals = {
    gold_ordinal_0: emptyRankTally(),
    gold_ordinal_1plus: emptyRankTally()
  };
  let anyPerGoldDisplacedBy = false;
  const perGoldDisplacedByTotals = emptyDistractorTally();

  for (const metric of metrics) {
    if (metric === undefined) continue;
    for (const [plane, entry] of Object.entries(
      metric.per_plane_recall_coverage
    )) {
      planeGoldCounts.set(
        plane,
        (planeGoldCounts.get(plane) ?? 0) + entry.gold_count
      );
      planeHitAt5Counts.set(
        plane,
        (planeHitAt5Counts.get(plane) ?? 0) + entry.hit_at_5_count
      );
    }
    nonMonotonicCount += metric.non_monotonic_count;
    nonMonotonicDenominator += metric.non_monotonic_denominator;
    highLexicalDemotedCount += metric.high_lexical_demoted_count;
    highLexicalDemotedDenominator += metric.high_lexical_demoted_denominator;
    candidateAbsentCount += metric.candidate_absent_count;
    candidateAbsentDenominator += metric.candidate_absent_denominator;
    noGoldCount += metric.no_gold_count;
    noGoldDenominator += metric.no_gold_denominator;
    evidenceStreamGoldDeliveryCount += metric.evidence_stream_gold_delivery_count;
    evidenceStreamGoldDeliveryDenominator +=
      metric.evidence_stream_gold_delivery_denominator;
    pathStreamTop10Count += metric.path_stream_top10_count;
    pathStreamTop10Denominator += metric.path_stream_top10_denominator;
    for (const [key, entry] of Object.entries(metric.budget_drop_distribution)) {
      const existing = budgetCounts.get(key) ?? { count: 0, denominator: 0 };
      budgetCounts.set(key, {
        count: existing.count + entry.count,
        denominator: existing.denominator + entry.denominator
      });
    }
    for (const [key, count] of Object.entries(metric.miss_distribution)) {
      missDistribution[key] = (missDistribution[key] ?? 0) + count;
    }
    if (metric.cohort_attribution !== undefined) {
      anyCohortAttribution = true;
      cohortDeliveredPlaneCount +=
        metric.cohort_attribution.delivered_plane_count;
      cohortGoldSourcePlaneCount +=
        metric.cohort_attribution.gold_source_plane_count;
      cohortGoldFirstAdmittedCount +=
        metric.cohort_attribution.gold_first_admitted_count;
      cohortGoldWinningAdmissionCount +=
        metric.cohort_attribution.gold_winning_admission_count;
      cohortGoldHitAt5Count += metric.cohort_attribution.hit_at_5_count;
    }
    if (metric.path_vs_graph_fanin !== undefined) {
      anyPathVsGraphFanin = true;
      pathFaninGoldSourceCount +=
        metric.path_vs_graph_fanin.path_gold_source_count;
      pathFaninGoldHitAt5Count +=
        metric.path_vs_graph_fanin.path_gold_hit_at_5_count;
      graphFaninGoldSourceCount +=
        metric.path_vs_graph_fanin.graph_gold_source_count;
      graphFaninGoldHitAt5Count +=
        metric.path_vs_graph_fanin.graph_gold_hit_at_5_count;
      pathPrimaryGoldHitAt5Count +=
        metric.path_vs_graph_fanin.path_primary_hit_at_5_count;
      graphOnlyGoldHitAt5Count +=
        metric.path_vs_graph_fanin.graph_only_hit_at_5_count;
    }
    if (metric.gold_rank_buckets !== undefined) {
      anyGoldRankBuckets = true;
      accumulateRecord(goldRankBucketTotals, metric.gold_rank_buckets);
    }
    if (metric.top_distractor_breakdown !== undefined) {
      anyTopDistractor = true;
      accumulateRecord(topDistractorTotals, metric.top_distractor_breakdown);
    }
    if (metric.object_kind_delivery !== undefined) {
      anyObjectKindDelivery = true;
      accumulateRecord(objectKindDeliveryTotals, metric.object_kind_delivery);
    }
    if (metric.gold_facet_separation !== undefined) {
      anyGoldFacet = true;
      const facet = metric.gold_facet_separation;
      goldFacetTotals.separable += facet.separable;
      goldFacetTotals.overlapping += facet.overlapping;
      goldFacetTotals.indeterminate += facet.indeterminate;
      for (const [dim, count] of Object.entries(facet.gold_dimension_counts)) {
        goldDimensionCounts[dim] = (goldDimensionCounts[dim] ?? 0) + count;
      }
    }
    if (metric.per_gold_rank_buckets !== undefined) {
      anyPerGoldRankBuckets = true;
      accumulateRecord(
        perGoldRankBucketTotals.gold_ordinal_0,
        metric.per_gold_rank_buckets.gold_ordinal_0
      );
      accumulateRecord(
        perGoldRankBucketTotals.gold_ordinal_1plus,
        metric.per_gold_rank_buckets.gold_ordinal_1plus
      );
    }
    if (metric.per_gold_displaced_by !== undefined) {
      anyPerGoldDisplacedBy = true;
      accumulateRecord(perGoldDisplacedByTotals, metric.per_gold_displaced_by);
    }
  }

  const budgetDropDistribution = Object.fromEntries(
    [...budgetCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, entry]) => [
        key,
        {
          count: entry.count,
          share: ratio(entry.count, entry.denominator),
          denominator: entry.denominator
        }
      ])
  );

  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: ratio(nonMonotonicCount, nonMonotonicDenominator),
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: nonMonotonicDenominator,
    budget_drop_distribution: budgetDropDistribution,
    high_lexical_demoted_rate: ratio(
      highLexicalDemotedCount,
      highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: highLexicalDemotedDenominator,
    candidate_absent_count: candidateAbsentCount,
    candidate_absent_denominator: candidateAbsentDenominator,
    no_gold_count: noGoldCount,
    no_gold_denominator: noGoldDenominator,
    evidence_stream_gold_delivery_rate: ratio(
      evidenceStreamGoldDeliveryCount,
      evidenceStreamGoldDeliveryDenominator
    ),
    evidence_stream_gold_delivery_count: evidenceStreamGoldDeliveryCount,
    evidence_stream_gold_delivery_denominator:
      evidenceStreamGoldDeliveryDenominator,
    path_stream_top10_rate: ratio(pathStreamTop10Count, pathStreamTop10Denominator),
    path_stream_top10_count: pathStreamTop10Count,
    path_stream_top10_denominator: pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      planeGoldCounts,
      planeHitAt5Counts
    ),
    ...(anyCohortAttribution
      ? {
          cohort_attribution: {
            delivered_plane_count: cohortDeliveredPlaneCount,
            gold_source_plane_count: cohortGoldSourcePlaneCount,
            gold_first_admitted_count: cohortGoldFirstAdmittedCount,
            gold_winning_admission_count: cohortGoldWinningAdmissionCount,
            hit_at_5_count: cohortGoldHitAt5Count,
            hit_at_5_rate: ratio(
              cohortGoldHitAt5Count,
              cohortGoldSourcePlaneCount
            )
          }
        }
      : {}),
    ...(anyPathVsGraphFanin
      ? {
          path_vs_graph_fanin: {
            path_gold_source_count: pathFaninGoldSourceCount,
            path_gold_hit_at_5_count: pathFaninGoldHitAt5Count,
            path_gold_hit_at_5_rate: ratio(
              pathFaninGoldHitAt5Count,
              pathFaninGoldSourceCount
            ),
            graph_gold_source_count: graphFaninGoldSourceCount,
            graph_gold_hit_at_5_count: graphFaninGoldHitAt5Count,
            graph_gold_hit_at_5_rate: ratio(
              graphFaninGoldHitAt5Count,
              graphFaninGoldSourceCount
            ),
            path_primary_hit_at_5_count: pathPrimaryGoldHitAt5Count,
            graph_only_hit_at_5_count: graphOnlyGoldHitAt5Count
          }
        }
      : {}),
    ...(anyGoldRankBuckets ? { gold_rank_buckets: goldRankBucketTotals } : {}),
    ...(anyTopDistractor
      ? { top_distractor_breakdown: topDistractorTotals }
      : {}),
    ...(anyObjectKindDelivery
      ? { object_kind_delivery: objectKindDeliveryTotals }
      : {}),
    ...(anyGoldFacet
      ? {
          gold_facet_separation: {
            ...goldFacetTotals,
            gold_dimension_counts: goldDimensionCounts
          }
        }
      : {}),
    ...(anyPerGoldRankBuckets
      ? { per_gold_rank_buckets: perGoldRankBucketTotals }
      : {}),
    ...(anyPerGoldDisplacedBy
      ? { per_gold_displaced_by: perGoldDisplacedByTotals }
      : {}),
    miss_distribution: missDistribution
  };
}

function emptyRankTally() {
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

function emptyDistractorTally() {
  return {
    existing_score_dominant: 0,
    synthesis_reserved: 0,
    source_proximity_local_only: 0,
    path_or_graph_dominant: 0,
    lexical_topic_neighbor: 0,
    unknown: 0
  };
}

function accumulateRecord<K extends string>(
  target: Record<K, number>,
  source: Record<K, number>
): void {
  for (const key of Object.keys(target) as K[]) {
    target[key] += source[key];
  }
}
