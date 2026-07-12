import type { QualityMetrics } from "@do-soul/alaya-eval";
import {
  isAbstentionQuestionId
} from "./abstention.js";
import { COHORT_PLANE, isDeliveryBudgetLoss } from "./diagnostics-private.js";
import { readQuestionMissTaxonomy } from "./diagnostics-miss-taxonomy.js";
import type {
  DiagnosticRecallResult,
  LongMemEvalGoldDiagnostic,
  LongMemEvalMissTaxonomyDistribution,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";
import { createEmptyMissTaxonomyDistribution } from "./diagnostics-miss-taxonomy.js";
import { isEvaluatorIdentityUnscorable } from "./measurement/question-validity.js";
import {
  classifyGoldRankBucket,
  classifyTopDistractor,
  emptyGoldRankBucketTally,
  goldOrdinalSortRank,
  hasEvidenceStreamContribution,
  hasGoldGraphExpansionStream,
  hasGoldPathExpansionStream,
  hasPathStreamContribution,
  isDeliveredOrderNonMonotonic,
  type TopDistractorBucket
} from "./diagnostics-quality-helpers.js";

type GoldRankBuckets = NonNullable<QualityMetrics["gold_rank_buckets"]>;
type GoldFacetSeparation = Omit<
  NonNullable<QualityMetrics["gold_facet_separation"]>,
  "gold_dimension_counts"
>;

export interface QualityMetricsState {
  readonly missDistribution: Record<string, number>;
  readonly missTaxonomyDistribution: Record<
    keyof LongMemEvalMissTaxonomyDistribution,
    number
  >;
  readonly budgetDropCounts: Map<string, number>;
  readonly planeGoldCounts: Map<string, number>;
  readonly planeHitAt5Counts: Map<string, number>;
  readonly goldRankBuckets: GoldRankBuckets;
  readonly topDistractorBreakdown: Record<TopDistractorBucket, number>;
  readonly objectKindDelivery: NonNullable<QualityMetrics["object_kind_delivery"]>;
  readonly goldFacetSeparation: GoldFacetSeparation;
  readonly goldDimensionCounts: Record<string, number>;
  readonly perGoldRankBuckets: NonNullable<QualityMetrics["per_gold_rank_buckets"]>;
  readonly perGoldDisplacedBy: Record<TopDistractorBucket, number>;
  nonMonotonicCount: number;
  nonMonotonicDenominator: number;
  highLexicalDemotedCount: number;
  highLexicalDemotedDenominator: number;
  candidateAbsentCount: number;
  noGoldCount: number;
  evaluatorIdentityIssueCount: number;
  evaluatorIdentityUnscorableCount: number;
  budgetDropDenominator: number;
  evidenceStreamGoldDeliveryCount: number;
  evidenceStreamGoldDeliveryDenominator: number;
  pathStreamTop10Count: number;
  pathStreamTop10Denominator: number;
  abstentionTotal: number;
  abstentionUnscorable: number;
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

export function createQualityMetricsState(): QualityMetricsState {
  return {
    missDistribution: {},
    missTaxonomyDistribution: createEmptyMissTaxonomyDistribution(),
    budgetDropCounts: new Map(),
    planeGoldCounts: new Map(),
    planeHitAt5Counts: new Map(),
    goldRankBuckets: emptyGoldRankBucketTally(),
    topDistractorBreakdown: zeroTopDistractorBuckets(),
    objectKindDelivery: { memory_entry: 0, synthesis_capsule: 0, total_delivered: 0 },
    goldFacetSeparation: { separable: 0, overlapping: 0, indeterminate: 0 },
    goldDimensionCounts: {},
    perGoldRankBuckets: {
      gold_ordinal_0: emptyGoldRankBucketTally(),
      gold_ordinal_1plus: emptyGoldRankBucketTally()
    },
    perGoldDisplacedBy: zeroTopDistractorBuckets(),
    nonMonotonicCount: 0,
    nonMonotonicDenominator: 0,
    highLexicalDemotedCount: 0,
    highLexicalDemotedDenominator: 0,
    candidateAbsentCount: 0,
    noGoldCount: 0,
    evaluatorIdentityIssueCount: 0,
    evaluatorIdentityUnscorableCount: 0,
    budgetDropDenominator: 0,
    evidenceStreamGoldDeliveryCount: 0,
    evidenceStreamGoldDeliveryDenominator: 0,
    pathStreamTop10Count: 0,
    pathStreamTop10Denominator: 0,
    abstentionTotal: 0,
    abstentionUnscorable: 0,
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

function zeroTopDistractorBuckets(): Record<TopDistractorBucket, number> {
  return {
    existing_score_dominant: 0,
    synthesis_reserved: 0,
    source_proximity_local_only: 0,
    path_or_graph_dominant: 0,
    lexical_topic_neighbor: 0,
    unknown: 0
  };
}

export function recordQualityQuestion(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  recordQuestionBasics(state, question);
  recordDeliveredResults(state, question.delivered_results);
  for (const gold of question.gold) {
    recordGoldDiagnostic(state, gold);
  }
  if (!isAbstentionQuestionId(question.question_id) && question.gold.length > 0) {
    recordBestGoldMiss(state, question);
    recordPerGoldRankBuckets(state, question);
  }
}

function recordQuestionBasics(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  state.missDistribution[question.miss_classification] =
    (state.missDistribution[question.miss_classification] ?? 0) + 1;
  const missTaxonomy = readQuestionMissTaxonomy(question);
  if (missTaxonomy !== null) {
    state.missTaxonomyDistribution[missTaxonomy]++;
  }
  if (question.miss_classification === "candidate_absent") state.candidateAbsentCount++;
  if (question.miss_classification === "no_gold") state.noGoldCount++;
  if (question.cohort_ledger?.evaluation_issue_reason === "identity_join_error" ||
      question.cohort_ledger?.evaluation_issue_reason === "evaluator_data_identity_inconsistency" ||
      question.cohort_ledger?.evaluation_issue_reason === "evaluator_data_identity_indeterminate") {
    state.evaluatorIdentityIssueCount++;
  }
  if (isEvaluatorIdentityUnscorable(question)) {
    state.evaluatorIdentityUnscorableCount++;
  }
  recordAbstentionQuestion(state, question);
  if (isAbstentionQuestionId(question.question_id)) return;
  if (question.delivered_results.length >= 2) {
    state.nonMonotonicDenominator++;
    if (isDeliveredOrderNonMonotonic(question.delivered_results)) {
      state.nonMonotonicCount++;
    }
  }
}

function recordAbstentionQuestion(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  if (!isAbstentionQuestionId(question.question_id)) return;
  state.abstentionTotal++;
  state.abstentionUnscorable++;
}

function recordDeliveredResults(
  state: QualityMetricsState,
  deliveredResults: readonly DiagnosticRecallResult[]
): void {
  for (const delivered of deliveredResults) {
    state.pathStreamTop10Denominator++;
    state.objectKindDelivery.total_delivered++;
    if (delivered.object_kind === "synthesis_capsule") {
      state.objectKindDelivery.synthesis_capsule++;
    } else {
      state.objectKindDelivery.memory_entry++;
    }
    if (hasPathStreamContribution(delivered)) state.pathStreamTop10Count++;
    if (
      delivered.plane_first_admitted === COHORT_PLANE ||
      delivered.plane_winning_admission === COHORT_PLANE
    ) {
      state.cohortDeliveredPlaneCount++;
    }
  }
}

function recordGoldDiagnostic(
  state: QualityMetricsState,
  gold: LongMemEvalGoldDiagnostic
): void {
  const goldHitAt5 = gold.final_rank !== null && gold.final_rank <= 5;
  state.budgetDropDenominator++;
  recordGoldPlaneCoverage(state, gold, goldHitAt5);
  recordGoldCohort(state, gold, goldHitAt5);
  recordGoldFanin(state, gold, goldHitAt5);
  recordGoldBudgetAndLexical(state, gold);
  if (goldHitAt5) {
    state.evidenceStreamGoldDeliveryDenominator++;
    if (hasEvidenceStreamContribution(gold)) {
      state.evidenceStreamGoldDeliveryCount++;
    }
  }
}

function recordGoldPlaneCoverage(
  state: QualityMetricsState,
  gold: LongMemEvalGoldDiagnostic,
  goldHitAt5: boolean
): void {
  for (const plane of new Set(gold.source_planes)) {
    state.planeGoldCounts.set(plane, (state.planeGoldCounts.get(plane) ?? 0) + 1);
    if (goldHitAt5) {
      state.planeHitAt5Counts.set(
        plane,
        (state.planeHitAt5Counts.get(plane) ?? 0) + 1
      );
    }
  }
}

function recordGoldCohort(
  state: QualityMetricsState,
  gold: LongMemEvalGoldDiagnostic,
  goldHitAt5: boolean
): void {
  if (gold.source_planes.includes(COHORT_PLANE)) {
    state.cohortGoldSourcePlaneCount++;
    if (goldHitAt5) state.cohortGoldHitAt5Count++;
  }
  if (gold.plane_first_admitted === COHORT_PLANE) {
    state.cohortGoldFirstAdmittedCount++;
  }
  if (gold.plane_winning_admission === COHORT_PLANE) {
    state.cohortGoldWinningAdmissionCount++;
  }
}

function recordGoldFanin(
  state: QualityMetricsState,
  gold: LongMemEvalGoldDiagnostic,
  goldHitAt5: boolean
): void {
  const bearsPathFanin = hasGoldPathExpansionStream(gold);
  const bearsGraphFanin = hasGoldGraphExpansionStream(gold);
  if (bearsPathFanin) {
    state.pathFaninGoldSourceCount++;
    if (goldHitAt5) {
      state.pathFaninGoldHitAt5Count++;
      state.pathPrimaryGoldHitAt5Count++;
    }
  }
  if (bearsGraphFanin) {
    state.graphFaninGoldSourceCount++;
    if (goldHitAt5) {
      state.graphFaninGoldHitAt5Count++;
      if (!bearsPathFanin) state.graphOnlyGoldHitAt5Count++;
    }
  }
}

function recordGoldBudgetAndLexical(
  state: QualityMetricsState,
  gold: LongMemEvalGoldDiagnostic
): void {
  if (isDeliveryBudgetLoss(gold) && gold.budget_drop_reason !== null) {
    state.budgetDropCounts.set(
      gold.budget_drop_reason,
      (state.budgetDropCounts.get(gold.budget_drop_reason) ?? 0) + 1
    );
  }
  if (gold.lexical_rank !== null && gold.final_rank !== null) {
    state.highLexicalDemotedDenominator++;
    if (gold.lexical_rank > 0.8 && gold.final_rank > 5) {
      state.highLexicalDemotedCount++;
    }
  }
}

function recordBestGoldMiss(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  if (question.hit_at_5) {
    state.goldRankBuckets.delivered_top5++;
    return;
  }
  state.goldRankBuckets[classifyBestGoldRank(question.gold)]++;
  for (const delivered of question.delivered_results) {
    if (delivered.rank <= 5) {
      state.topDistractorBreakdown[classifyTopDistractor(delivered)]++;
    }
  }
  recordGoldFacetSeparation(state, question);
}

function classifyBestGoldRank(
  golds: readonly LongMemEvalGoldDiagnostic[]
): keyof GoldRankBuckets {
  let bestRank: number | null = null;
  for (const gold of golds) {
    const rank = gold.pre_budget_rank ?? gold.fused_rank;
    if (rank !== null && (bestRank === null || rank < bestRank)) {
      bestRank = rank;
    }
  }
  if (bestRank === null) return "candidate_absent";
  if (bestRank <= 10) return "pre_budget_6_10";
  if (bestRank <= 25) return "pre_budget_11_25";
  if (bestRank <= 50) return "pre_budget_26_50";
  if (bestRank <= 100) return "pre_budget_51_100";
  return "pre_budget_gt_100";
}

function recordGoldFacetSeparation(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  const goldDims = new Set(
    question.gold.map((g) => g.dimension).filter((d): d is string => d !== null)
  );
  for (const dim of goldDims) {
    state.goldDimensionCounts[dim] = (state.goldDimensionCounts[dim] ?? 0) + 1;
  }
  const distractorDims = new Set(
    question.delivered_results
      .filter((d) => d.rank <= 5 && d.object_kind !== "synthesis_capsule")
      .map((d) => d.dimension)
      .filter((d): d is string => d !== null)
  );
  if (goldDims.size === 0 || distractorDims.size === 0) {
    state.goldFacetSeparation.indeterminate++;
  } else if ([...goldDims].some((d) => distractorDims.has(d))) {
    state.goldFacetSeparation.overlapping++;
  } else {
    state.goldFacetSeparation.separable++;
  }
}

function recordPerGoldRankBuckets(
  state: QualityMetricsState,
  question: LongMemEvalQuestionDiagnostic
): void {
  const orderedGold = [...question.gold].sort(
    (left, right) => goldOrdinalSortRank(left) - goldOrdinalSortRank(right)
  );
  orderedGold.forEach((gold, ordinal) => {
    const bucket = classifyGoldRankBucket(gold);
    const tally =
      ordinal === 0
        ? state.perGoldRankBuckets.gold_ordinal_0
        : state.perGoldRankBuckets.gold_ordinal_1plus;
    tally[bucket]++;
    if (ordinal > 0 && bucket !== "delivered_top5") {
      recordPerGoldDisplacedBy(state, question.delivered_results);
    }
  });
}

function recordPerGoldDisplacedBy(
  state: QualityMetricsState,
  deliveredResults: readonly DiagnosticRecallResult[]
): void {
  for (const delivered of deliveredResults) {
    if (delivered.rank <= 5) {
      state.perGoldDisplacedBy[classifyTopDistractor(delivered)]++;
    }
  }
}
