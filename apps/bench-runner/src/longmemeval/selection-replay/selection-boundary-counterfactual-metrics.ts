export type CounterfactualRecordEvaluation = Readonly<{
  readonly questionId: string;
  readonly baselineKeys: readonly string[];
  readonly counterfactualKeys: readonly string[] | null;
  readonly unseenTokenFailure: boolean;
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

export type CounterfactualCellAccumulator = {
  baselineCompositionCount: number;
  counterfactualEvaluableCount: number;
  unseenTokenFailureCount: number;
  answerableCount: number;
  evaluableAnswerableCount: number;
  baselineAnyAt5: number;
  baselineAnyAt5OnEvaluable: number;
  counterfactualAnyAt5: number;
  anyAt5Gain: number;
  anyAt5Loss: number;
  goldBearingCount: number;
  evaluableGoldBearingCount: number;
  baselineFullGoldAt5: number;
  baselineFullGoldAt5OnEvaluable: number;
  counterfactualFullGoldAt5: number;
  membershipChurnQuestions: number;
  orderChurnQuestions: number;
};

export type SelectionCounterfactualCellMetricsBase = Readonly<{
  readonly recordCount: number;
  readonly baselineCompositionCount: number;
  readonly counterfactualEvaluableCount: number;
  readonly unseenTokenFailureCount: number;
  readonly answerableCount: number;
  readonly evaluableAnswerableCount: number;
  readonly baselineAnyAt5: number;
  readonly baselineAnyAt5OnEvaluable: number;
  readonly counterfactualAnyAt5: number;
  readonly anyAt5Gain: number;
  readonly anyAt5Loss: number;
  readonly goldBearingCount: number;
  readonly evaluableGoldBearingCount: number;
  readonly baselineFullGoldAt5: number;
  readonly baselineFullGoldAt5OnEvaluable: number;
  readonly counterfactualFullGoldAt5: number;
  readonly fullGoldAt5DeltaOnEvaluable: number;
  readonly membershipChurnQuestions: number;
  readonly orderChurnQuestions: number;
  readonly nonRegressive: boolean;
  readonly cellBlockers: readonly string[];
}>;

export function createCounterfactualCellAccumulator(
): CounterfactualCellAccumulator {
  return {
    baselineCompositionCount: 0,
    counterfactualEvaluableCount: 0,
    unseenTokenFailureCount: 0,
    answerableCount: 0,
    evaluableAnswerableCount: 0,
    baselineAnyAt5: 0,
    baselineAnyAt5OnEvaluable: 0,
    counterfactualAnyAt5: 0,
    anyAt5Gain: 0,
    anyAt5Loss: 0,
    goldBearingCount: 0,
    evaluableGoldBearingCount: 0,
    baselineFullGoldAt5: 0,
    baselineFullGoldAt5OnEvaluable: 0,
    counterfactualFullGoldAt5: 0,
    membershipChurnQuestions: 0,
    orderChurnQuestions: 0
  };
}

export function accumulateCounterfactualRecord(
  acc: CounterfactualCellAccumulator,
  evaluation: CounterfactualRecordEvaluation
): void {
  acc.baselineCompositionCount += 1;
  if (evaluation.unseenTokenFailure) acc.unseenTokenFailureCount += 1;
  if (evaluation.counterfactualKeys !== null) {
    acc.counterfactualEvaluableCount += 1;
    if (!sameMembership(evaluation.baselineKeys, evaluation.counterfactualKeys)) {
      acc.membershipChurnQuestions += 1;
    }
    if (!sameOrder(evaluation.baselineKeys, evaluation.counterfactualKeys)) {
      acc.orderChurnQuestions += 1;
    }
  }
  if (!evaluation.answerable) return;
  acc.answerableCount += 1;
  accumulateAnswerableGoldMetrics(acc, evaluation);
}

export function rollupCounterfactualCellMetricsBase(
  acc: CounterfactualCellAccumulator,
  recordCount: number,
  authoritativeOnly: boolean
): SelectionCounterfactualCellMetricsBase {
  const fullGoldAt5DeltaOnEvaluable =
    acc.counterfactualFullGoldAt5 - acc.baselineFullGoldAt5OnEvaluable;
  const cellBlockers = collectCellBlockers({
    anyAt5Loss: acc.anyAt5Loss,
    fullGoldAt5Delta: fullGoldAt5DeltaOnEvaluable,
    answerableCount: acc.answerableCount,
    baselineCompositionCount: acc.baselineCompositionCount,
    counterfactualEvaluableCount: acc.counterfactualEvaluableCount,
    unseenTokenFailureCount: acc.unseenTokenFailureCount,
    recordCount: authoritativeOnly ? acc.baselineCompositionCount : recordCount
  });
  return Object.freeze({
    recordCount,
    baselineCompositionCount: acc.baselineCompositionCount,
    counterfactualEvaluableCount: acc.counterfactualEvaluableCount,
    unseenTokenFailureCount: acc.unseenTokenFailureCount,
    answerableCount: acc.answerableCount,
    evaluableAnswerableCount: acc.evaluableAnswerableCount,
    baselineAnyAt5: acc.baselineAnyAt5,
    baselineAnyAt5OnEvaluable: acc.baselineAnyAt5OnEvaluable,
    counterfactualAnyAt5: acc.counterfactualAnyAt5,
    anyAt5Gain: acc.anyAt5Gain,
    anyAt5Loss: acc.anyAt5Loss,
    goldBearingCount: acc.goldBearingCount,
    evaluableGoldBearingCount: acc.evaluableGoldBearingCount,
    baselineFullGoldAt5: acc.baselineFullGoldAt5,
    baselineFullGoldAt5OnEvaluable: acc.baselineFullGoldAt5OnEvaluable,
    counterfactualFullGoldAt5: acc.counterfactualFullGoldAt5,
    fullGoldAt5DeltaOnEvaluable,
    membershipChurnQuestions: acc.membershipChurnQuestions,
    orderChurnQuestions: acc.orderChurnQuestions,
    nonRegressive: cellBlockers.length === 0,
    cellBlockers
  });
}

export function anyGoldInHead(
  candidateKeys: readonly string[],
  goldObjectIds: readonly string[],
  head: number
): boolean {
  if (goldObjectIds.length === 0) return false;
  const gold = new Set(goldObjectIds);
  return candidateKeys.slice(0, head).some((key) =>
    gold.has(objectIdFromCandidateKey(key))
  );
}

export function fullGoldInHead(
  candidateKeys: readonly string[],
  goldObjectIds: readonly string[],
  head: number
): boolean {
  return goldObjectIds.length > 0 &&
    goldObjectsInHead(candidateKeys, goldObjectIds, head) === goldObjectIds.length;
}

export function goldObjectsInHead(
  candidateKeys: readonly string[],
  goldObjectIds: readonly string[],
  head: number
): number {
  if (goldObjectIds.length === 0) return 0;
  const delivered = new Set(
    candidateKeys.slice(0, head).map(objectIdFromCandidateKey)
  );
  return goldObjectIds.filter((objectId) => delivered.has(objectId)).length;
}

export function sameMembership(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((key) => rightSet.has(key));
}

export function sameOrder(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index]);
}

function accumulateAnswerableGoldMetrics(
  acc: CounterfactualCellAccumulator,
  evaluation: CounterfactualRecordEvaluation
): void {
  const baselineHit = anyGoldInHead(
    evaluation.baselineKeys,
    evaluation.goldObjectIds,
    5
  );
  if (baselineHit) acc.baselineAnyAt5 += 1;
  if (evaluation.goldObjectIds.length > 0) {
    acc.goldBearingCount += 1;
    if (fullGoldInHead(evaluation.baselineKeys, evaluation.goldObjectIds, 5)) {
      acc.baselineFullGoldAt5 += 1;
    }
  }
  if (evaluation.counterfactualKeys === null) return;
  acc.evaluableAnswerableCount += 1;
  if (baselineHit) acc.baselineAnyAt5OnEvaluable += 1;
  const counterfactualHit = anyGoldInHead(
    evaluation.counterfactualKeys,
    evaluation.goldObjectIds,
    5
  );
  if (counterfactualHit) acc.counterfactualAnyAt5 += 1;
  if (!baselineHit && counterfactualHit) acc.anyAt5Gain += 1;
  if (baselineHit && !counterfactualHit) acc.anyAt5Loss += 1;
  if (evaluation.goldObjectIds.length === 0) return;
  acc.evaluableGoldBearingCount += 1;
  if (fullGoldInHead(evaluation.baselineKeys, evaluation.goldObjectIds, 5)) {
    acc.baselineFullGoldAt5OnEvaluable += 1;
  }
  if (fullGoldInHead(evaluation.counterfactualKeys, evaluation.goldObjectIds, 5)) {
    acc.counterfactualFullGoldAt5 += 1;
  }
}

function collectCellBlockers(input: Readonly<{
  readonly anyAt5Loss: number;
  readonly fullGoldAt5Delta: number;
  readonly answerableCount: number;
  readonly baselineCompositionCount: number;
  readonly counterfactualEvaluableCount: number;
  readonly unseenTokenFailureCount: number;
  readonly recordCount: number;
}>): readonly string[] {
  const blockers: string[] = [];
  if (input.counterfactualEvaluableCount !== input.baselineCompositionCount) {
    blockers.push("incomplete_counterfactual_coverage");
  }
  if (input.unseenTokenFailureCount > 0) {
    blockers.push("unseen_token_estimate_failures");
  }
  if (input.anyAt5Loss > 0) blockers.push("any_at_5_regression");
  if (input.fullGoldAt5Delta < 0) blockers.push("full_gold_at_5_decline");
  if (input.answerableCount <= 0) blockers.push("no_answerable_questions");
  if (input.recordCount <= 0) blockers.push("no_records");
  return Object.freeze(blockers);
}

function objectIdFromCandidateKey(candidateKey: string): string {
  const parts = candidateKey.split(":");
  return parts[parts.length - 1]!;
}
