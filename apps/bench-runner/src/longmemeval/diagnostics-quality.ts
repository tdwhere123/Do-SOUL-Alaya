import type { QualityMetrics } from "@do-soul/alaya-eval";
import {
  ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
  isAbstentionQuestionId
} from "./abstention.js";
import { COHORT_PLANE, isDeliveryBudgetLoss } from "./diagnostics-private.js";
import type {
  DiagnosticRecallResult,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";

export function buildLongMemEvalQualityMetrics(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): QualityMetrics {
  const missDistribution: Record<string, number> = {};
  const budgetDropCounts = new Map<string, number>();
  let nonMonotonicCount = 0;
  let nonMonotonicDenominator = 0;
  let highLexicalDemotedCount = 0;
  let highLexicalDemotedDenominator = 0;
  let candidateAbsentCount = 0;
  let noGoldCount = 0;
  let budgetDropDenominator = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  // @anchor longmemeval-abstention: calibrated-confidence audit counters.
  let abstentionTotal = 0;
  let abstentionCorrectAt1 = 0;
  let abstentionCorrectAt5 = 0;
  let abstentionCorrectAt10 = 0;
  // invariant: per-plane recall coverage keys are driven by the gold
  // candidates' source_planes, never a hardcoded plane list.
  const planeGoldCounts = new Map<string, number>();
  const planeHitAt5Counts = new Map<string, number>();
  // Cohort fan-in attribution (codex I2). Five classes splitting how the session
  // cohort plane participates in gold delivery; see CohortAttributionSchema.
  let cohortDeliveredPlaneCount = 0;
  let cohortGoldSourcePlaneCount = 0;
  let cohortGoldFirstAdmittedCount = 0;
  let cohortGoldWinningAdmissionCount = 0;
  let cohortGoldHitAt5Count = 0;
  // Path-vs-graph fan-in diagnostic: how generic path_expansion (direct hop-1
  // path fan-in) vs graph_expansion (multi-hop) streams carry gold into top-5
  // SEPARATELY. The unified path plane's double-count guard credits a
  // direct 1-hop path_expansion term before any multi-hop graph_expansion term,
  // so a gold bearing both is attributed path-primary. graph_only isolates gold
  // that reached top-5 purely via multi-hop. This block proves stream/plane
  // attribution only; relation-kind provenance is not present in recall
  // diagnostics. see also: packages/eval/src/schema/kpi-schema.ts PathVsGraphFaninSchema.
  let pathFaninGoldSourceCount = 0;
  let pathFaninGoldHitAt5Count = 0;
  let graphFaninGoldSourceCount = 0;
  let graphFaninGoldHitAt5Count = 0;
  let pathPrimaryGoldHitAt5Count = 0;
  let graphOnlyGoldHitAt5Count = 0;
  // @anchor longmemeval-gold-rank-buckets: best-gold rank distribution over
  // answerable questions (abstention + no-gold excluded). MECE — every
  // counted question lands in exactly one bucket.
  const goldRankBuckets = {
    delivered_top5: 0,
    pre_budget_6_10: 0,
    pre_budget_11_25: 0,
    pre_budget_26_50: 0,
    pre_budget_51_100: 0,
    pre_budget_gt_100: 0,
    candidate_absent: 0
  };
  // @anchor longmemeval-top-distractor-breakdown / object-kind-delivery
  const topDistractorBreakdown = {
    existing_score_dominant: 0,
    synthesis_reserved: 0,
    source_proximity_local_only: 0,
    path_or_graph_dominant: 0,
    lexical_topic_neighbor: 0,
    unknown: 0
  };
  const objectKindDelivery = {
    memory_entry: 0,
    synthesis_capsule: 0,
    total_delivered: 0
  };
  // @anchor longmemeval-gold-facet-separation: per-miss, gold dimension disjoint
  // from top-5 distractors' (separable) vs shared (overlapping).
  const goldFacetSeparation = {
    separable: 0,
    overlapping: 0,
    indeterminate: 0
  };
  const goldDimensionCounts: Record<string, number> = {};

  for (const question of diagnostics) {
    missDistribution[question.miss_classification] =
      (missDistribution[question.miss_classification] ?? 0) + 1;
    if (question.miss_classification === "candidate_absent") {
      candidateAbsentCount++;
    }
    if (question.miss_classification === "no_gold") {
      noGoldCount++;
    }
    if (isAbstentionQuestionId(question.question_id)) {
      abstentionTotal++;
      if (question.hit_at_1) abstentionCorrectAt1++;
      if (question.hit_at_5) abstentionCorrectAt5++;
      if (question.hit_at_10) abstentionCorrectAt10++;
    }

    if (question.delivered_results.length >= 2) {
      nonMonotonicDenominator++;
      if (isDeliveredOrderNonMonotonic(question.delivered_results)) {
        nonMonotonicCount++;
      }
    }

    for (const delivered of question.delivered_results) {
      pathStreamTop10Denominator++;
      objectKindDelivery.total_delivered++;
      if (delivered.object_kind === "synthesis_capsule") {
        objectKindDelivery.synthesis_capsule++;
      } else {
        objectKindDelivery.memory_entry++;
      }
      if (hasPathStreamContribution(delivered)) {
        pathStreamTop10Count++;
      }
      if (
        delivered.plane_first_admitted === COHORT_PLANE ||
        delivered.plane_winning_admission === COHORT_PLANE
      ) {
        cohortDeliveredPlaneCount++;
      }
    }

    for (const gold of question.gold) {
      budgetDropDenominator++;
      const goldHitAt5 = gold.final_rank !== null && gold.final_rank <= 5;
      for (const plane of new Set(gold.source_planes)) {
        planeGoldCounts.set(plane, (planeGoldCounts.get(plane) ?? 0) + 1);
        if (goldHitAt5) {
          planeHitAt5Counts.set(
            plane,
            (planeHitAt5Counts.get(plane) ?? 0) + 1
          );
        }
      }
      if (gold.source_planes.includes(COHORT_PLANE)) {
        cohortGoldSourcePlaneCount++;
        if (goldHitAt5) {
          cohortGoldHitAt5Count++;
        }
      }
      if (gold.plane_first_admitted === COHORT_PLANE) {
        cohortGoldFirstAdmittedCount++;
      }
      if (gold.plane_winning_admission === COHORT_PLANE) {
        cohortGoldWinningAdmissionCount++;
      }
      const bearsPathFanin = hasGoldPathExpansionStream(gold);
      const bearsGraphFanin = hasGoldGraphExpansionStream(gold);
      if (bearsPathFanin) {
        pathFaninGoldSourceCount++;
        if (goldHitAt5) {
          pathFaninGoldHitAt5Count++;
          // Double-count guard: a gold bearing the direct hop-1 path_expansion
          // term is attributed path-primary even if it also bears graph_expansion.
          pathPrimaryGoldHitAt5Count++;
        }
      }
      if (bearsGraphFanin) {
        graphFaninGoldSourceCount++;
        if (goldHitAt5) {
          graphFaninGoldHitAt5Count++;
          if (!bearsPathFanin) {
            graphOnlyGoldHitAt5Count++;
          }
        }
      }
      if (isDeliveryBudgetLoss(gold)) {
        const dropReason = gold.budget_drop_reason;
        if (dropReason === null) continue;
        budgetDropCounts.set(
          dropReason,
          (budgetDropCounts.get(dropReason) ?? 0) + 1
        );
      }
      if (gold.lexical_rank !== null && gold.final_rank !== null) {
        highLexicalDemotedDenominator++;
        if (gold.lexical_rank > 0.8 && gold.final_rank > 5) {
          highLexicalDemotedCount++;
        }
      }
      if (gold.final_rank !== null && gold.final_rank <= 5) {
        evidenceStreamGoldDeliveryDenominator++;
        if (hasEvidenceStreamContribution(gold)) {
          evidenceStreamGoldDeliveryCount++;
        }
      }
    }

    // Best-gold rank bucket: hit@5 delivers; otherwise place the best gold's
    // pre-budget rank (fused_rank fallback) to expose rerank headroom vs a
    // structural pool wall. Abstention/no-gold carry no gold rank.
    if (!isAbstentionQuestionId(question.question_id) && question.gold.length > 0) {
      if (question.hit_at_5) {
        goldRankBuckets.delivered_top5++;
      } else {
        let bestRank: number | null = null;
        for (const gold of question.gold) {
          const rank = gold.pre_budget_rank ?? gold.fused_rank;
          if (rank !== null && (bestRank === null || rank < bestRank)) {
            bestRank = rank;
          }
        }
        if (bestRank === null) {
          goldRankBuckets.candidate_absent++;
        } else if (bestRank <= 10) {
          goldRankBuckets.pre_budget_6_10++;
        } else if (bestRank <= 25) {
          goldRankBuckets.pre_budget_11_25++;
        } else if (bestRank <= 50) {
          goldRankBuckets.pre_budget_26_50++;
        } else if (bestRank <= 100) {
          goldRankBuckets.pre_budget_51_100++;
        } else {
          goldRankBuckets.pre_budget_gt_100++;
        }
        // The top-5 delivered results occupy the slots the missed gold should
        // have had. Attribute each to the stream/kind that carried it.
        for (const delivered of question.delivered_results) {
          if (delivered.rank <= 5) {
            topDistractorBreakdown[classifyTopDistractor(delivered)]++;
          }
        }
        // Would a dimension sieve separate gold from the top-5 distractors?
        const goldDims = new Set(
          question.gold
            .map((g) => g.dimension)
            .filter((d): d is string => d !== null)
        );
        for (const dim of goldDims) {
          goldDimensionCounts[dim] = (goldDimensionCounts[dim] ?? 0) + 1;
        }
        const distractorDims = new Set(
          question.delivered_results
            // synthesis_capsule dimension is a schema placeholder, not real.
            .filter((d) => d.rank <= 5 && d.object_kind !== "synthesis_capsule")
            .map((d) => d.dimension)
            .filter((d): d is string => d !== null)
        );
        if (goldDims.size === 0 || distractorDims.size === 0) {
          goldFacetSeparation.indeterminate++;
        } else if ([...goldDims].some((d) => distractorDims.has(d))) {
          goldFacetSeparation.overlapping++;
        } else {
          goldFacetSeparation.separable++;
        }
      }
    }
  }

  const questionDenominator = diagnostics.length;
  if (!budgetDropCounts.has("max_entries")) {
    budgetDropCounts.set("max_entries", 0);
  }
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: ratio(nonMonotonicCount, questionDenominator),
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: questionDenominator,
    budget_drop_distribution: Object.fromEntries(
      [...budgetDropCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, count]) => [
          key,
          {
            count,
            share: ratio(count, budgetDropDenominator),
            denominator: budgetDropDenominator
          }
        ])
    ),
    high_lexical_demoted_rate: ratio(
      highLexicalDemotedCount,
      highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: highLexicalDemotedDenominator,
    candidate_absent_count: candidateAbsentCount,
    candidate_absent_denominator: questionDenominator,
    no_gold_count: noGoldCount,
    no_gold_denominator: questionDenominator,
    evidence_stream_gold_delivery_rate: ratio(
      evidenceStreamGoldDeliveryCount,
      evidenceStreamGoldDeliveryDenominator
    ),
    evidence_stream_gold_delivery_count: evidenceStreamGoldDeliveryCount,
    evidence_stream_gold_delivery_denominator: evidenceStreamGoldDeliveryDenominator,
    path_stream_top10_rate: ratio(pathStreamTop10Count, pathStreamTop10Denominator),
    path_stream_top10_count: pathStreamTop10Count,
    path_stream_top10_denominator: pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      planeGoldCounts,
      planeHitAt5Counts
    ),
    cohort_attribution: {
      delivered_plane_count: cohortDeliveredPlaneCount,
      gold_source_plane_count: cohortGoldSourcePlaneCount,
      gold_first_admitted_count: cohortGoldFirstAdmittedCount,
      gold_winning_admission_count: cohortGoldWinningAdmissionCount,
      hit_at_5_count: cohortGoldHitAt5Count,
      hit_at_5_rate: ratio(cohortGoldHitAt5Count, cohortGoldSourcePlaneCount)
    },
    // path_*  = golds bearing the direct hop-1 path_expansion stream.
    // graph_* = golds admitted on the MULTI-HOP graph_expansion plane only
    //   (hasGoldGraphExpansionStream restricts to admission-plane membership; the
    //   hop-1-polluted per_stream_rank.graph_expansion term is excluded so hop-1
    //   path golds are NOT over-reported as graph-bearing).
    // path_primary_hit_at_5_count / graph_only_hit_at_5_count are the disjoint
    //   partition: a gold bearing both is credited path-primary; graph_only is the
    //   genuine multi-hop-only metric. graph_gold_* can still overlap path_* when a
    //   gold reached top-5 by both a direct hop-1 path AND a multi-hop graph admit.
    path_vs_graph_fanin: {
      path_gold_source_count: pathFaninGoldSourceCount,
      path_gold_hit_at_5_count: pathFaninGoldHitAt5Count,
      path_gold_hit_at_5_rate: ratio(pathFaninGoldHitAt5Count, pathFaninGoldSourceCount),
      graph_gold_source_count: graphFaninGoldSourceCount,
      graph_gold_hit_at_5_count: graphFaninGoldHitAt5Count,
      graph_gold_hit_at_5_rate: ratio(graphFaninGoldHitAt5Count, graphFaninGoldSourceCount),
      path_primary_hit_at_5_count: pathPrimaryGoldHitAt5Count,
      graph_only_hit_at_5_count: graphOnlyGoldHitAt5Count
    },
    // Calibrated-confidence audit block: how many `_abs` questions were
    // scored, how many stayed appropriately unconfident at each k, and the
    // false-confident threshold the verdict used. A future benchmark swap
    // can re-derive the threshold from this record.
    abstention: {
      schema_version: "bench-abstention.v1",
      total: abstentionTotal,
      false_confident_threshold: ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
      correct_at_1: abstentionCorrectAt1,
      correct_at_5: abstentionCorrectAt5,
      correct_at_10: abstentionCorrectAt10,
      false_confident_at_1: abstentionTotal - abstentionCorrectAt1,
      false_confident_at_5: abstentionTotal - abstentionCorrectAt5,
      false_confident_at_10: abstentionTotal - abstentionCorrectAt10
    },
    gold_rank_buckets: goldRankBuckets,
    top_distractor_breakdown: topDistractorBreakdown,
    object_kind_delivery: objectKindDelivery,
    gold_facet_separation: {
      ...goldFacetSeparation,
      gold_dimension_counts: goldDimensionCounts
    },
    miss_distribution: missDistribution
  };
}

type TopDistractorBucket =
  | "existing_score_dominant"
  | "synthesis_reserved"
  | "source_proximity_local_only"
  | "path_or_graph_dominant"
  | "lexical_topic_neighbor"
  | "unknown";

// Attribute a top-5 distractor (a result occupying a slot a missed gold wanted)
// to the dominant force that put it there: a synthesis reserve, the scalar
// existing_score prior, source proximity, path/graph fan-in, or a lexical/
// semantic topic neighbor — by its largest fused-rank stream contribution.
function classifyTopDistractor(
  delivered: DiagnosticRecallResult
): TopDistractorBucket {
  if (delivered.object_kind === "synthesis_capsule") {
    return "synthesis_reserved";
  }
  const contributions = delivered.fused_rank_contribution_per_stream;
  if (contributions === null) {
    return "unknown";
  }
  let bestStream: string | null = null;
  let bestValue = 0;
  for (const [stream, value] of Object.entries(contributions)) {
    if (typeof value === "number" && value > bestValue) {
      bestValue = value;
      bestStream = stream;
    }
  }
  if (bestStream === null) {
    return "unknown";
  }
  if (bestStream === "existing_score") {
    return "existing_score_dominant";
  }
  if (bestStream === "source_proximity" || bestStream === "source_evidence_agreement") {
    return "source_proximity_local_only";
  }
  if (
    bestStream === "path_expansion" ||
    bestStream === "graph_expansion" ||
    bestStream === "entity_seed"
  ) {
    return "path_or_graph_dominant";
  }
  return "lexical_topic_neighbor";
}

function hasEvidenceStreamContribution(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("evidence_anchor") ||
    gold.source_planes.includes("evidence_fts") ||
    gold.source_channels.includes("evidence_anchor") ||
    gold.source_channels.includes("evidence_fts") ||
    (gold.per_stream_rank?.evidence_fts ?? null) !== null ||
    (gold.per_stream_rank?.evidence_structural_agreement ?? null) !== null ||
    (gold.per_stream_rank?.source_evidence_agreement ?? null) !== null
  );
}

function hasPathStreamContribution(delivered: DiagnosticRecallResult): boolean {
  return (
    delivered.plane_first_admitted === "path_expansion" ||
    delivered.plane_winning_admission === "path_expansion" ||
    (delivered.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Path fan-in diagnostic: a gold candidate bears the path_expansion stream when
// it was admitted on the path plane or fired the path_expansion fusion stream.
// The diagnostic does not prove a specific relation_kind.
// see also: apps/bench-runner/src/longmemeval/diagnostics.ts buildLongMemEvalQualityMetrics
function hasGoldPathExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("path_expansion") ||
    gold.plane_first_admitted === "path_expansion" ||
    gold.plane_winning_admission === "path_expansion" ||
    (gold.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Graph fan-in diagnostic: a gold candidate bears genuine MULTI-HOP
// graph_expansion reach when it was admitted on the graph_expansion plane. The
// graph_expansion admission carries a double-count guard (it skips any target
// path_expansion already admitted as a direct hop-1 neighbor, see
// recall-service.ts addGraphExpansionCandidates), so plane membership isolates
// the hop-2+ reach the direct path pass never produced.
//
// invariant: the per_stream_rank.graph_expansion term is DELIBERATELY NOT a
// multi-hop signal here. The production graph_expansion fusion STREAM score is
// max(graphExpansionScores, normalizeGraphSupport(graphSupportCounts)) — the
// graphSupport aggregate can count hop-1 inbound support, so a direct hop-1 path
// gold fires a nonzero graph_expansion per_stream_rank too. Counting
// it would mis-attribute hop-1 path golds as graph-bearing and over-report
// graph_gold_*. We rely on the admission plane (true multi-hop) instead; the
// path-primary partition (hasGoldPathExpansionStream) still credits the direct
// hop-1 term, and graph_only_hit_at_5_count remains the clean multi-hop metric.
// see also: apps/bench-runner/src/longmemeval/diagnostics.ts buildLongMemEvalQualityMetrics
// see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
function hasGoldGraphExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("graph_expansion") ||
    gold.plane_first_admitted === "graph_expansion" ||
    gold.plane_winning_admission === "graph_expansion"
  );
}

function isDeliveredOrderNonMonotonic(
  results: readonly DiagnosticRecallResult[]
): boolean {
  const deliveredRanks = results.map((result) => result.rank);
  if (deliveredRanks.every(isFiniteDiagnosticRank)) {
    return isDeliveredRankOrderNonMonotonic(deliveredRanks);
  }
  const fusedRanks = results.map((result) => result.fused_rank);
  if (fusedRanks.every(isFiniteDiagnosticRank)) {
    return isDeliveredRankOrderNonMonotonic(fusedRanks);
  }
  return isDeliveredScoreOrderNonMonotonic(
    results.map((result) => result.relevance_score)
  );
}

function isFiniteDiagnosticRank(rank: number | null | undefined): rank is number {
  return typeof rank === "number" && Number.isFinite(rank);
}

function isDeliveredRankOrderNonMonotonic(ranks: readonly number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    const current = ranks[i];
    const previous = ranks[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current < previous) return true;
  }
  return false;
}

function isDeliveredScoreOrderNonMonotonic(scores: readonly number[]): boolean {
  for (let i = 1; i < scores.length; i++) {
    const current = scores[i];
    const previous = scores[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current > previous) return true;
  }
  return false;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

// @anchor per-plane-recall-coverage: shared by buildLongMemEvalQualityMetrics
// and cli.ts mergeQualityMetrics so single-shard and merged kpi.json carry
// the same per-plane block shape.
export function buildPerPlaneRecallCoverage(
  goldCounts: ReadonlyMap<string, number>,
  hitAt5Counts: ReadonlyMap<string, number>
): QualityMetrics["per_plane_recall_coverage"] {
  return Object.fromEntries(
    [...goldCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([plane, goldCount]) => {
        const hitCount = hitAt5Counts.get(plane) ?? 0;
        return [
          plane,
          {
            gold_count: goldCount,
            hit_at_5_count: hitCount,
            hit_at_5_rate: ratio(hitCount, goldCount)
          }
        ];
      })
  );
}
