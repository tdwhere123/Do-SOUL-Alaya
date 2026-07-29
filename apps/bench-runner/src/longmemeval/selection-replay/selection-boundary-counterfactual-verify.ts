import { readFile } from "node:fs/promises";
import {
  counterfactualDeliveredCandidateKeys,
  INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR,
  reconstructFineAssessmentComposition,
  reconstructIndependentEmbeddingEvidenceComposition,
  SELECTION_BOUNDARY_FIDELITY_MISMATCH,
  type SelectionCompositionOptions
} from "@do-soul/alaya-core";
import {
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
} from "./selection-boundary-spool.js";

const COUNTERFACTUAL_ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection counterfactual record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection counterfactual record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection counterfactual gzip exceeds the ${maxBytes} byte size limit`
});

export type IndependentEmbeddingCounterfactualCellMetrics = Readonly<{
  readonly operator: typeof INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR;
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
  /** Full-cell gates require complete evaluability plus no regression. */
  readonly nonRegressive: boolean;
  readonly cellBlockers: readonly string[];
}>;

type GoldQuestion = Readonly<{
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

type CounterfactualRecordEvaluation = Readonly<{
  readonly baselineKeys: readonly string[];
  readonly counterfactualKeys: readonly string[] | null;
  readonly unseenTokenFailure: boolean;
  readonly answerable: boolean;
  readonly goldObjectIds: readonly string[];
}>;

type CounterfactualCellAccumulator = {
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

/**
 * Evaluate the registered independent-embedding counterfactual against a
 * closed-capture selection sidecar plus slim gold map. Unseen token estimates
 * fail loud per question and mark the cell incomplete (do not invent estimates).
 */
export async function evaluateIndependentEmbeddingEvidenceCounterfactual(
  artifactPath: string,
  goldMapPath: string,
  options: SelectionCompositionOptions & {
    readonly maxArtifactBytes?: number;
    readonly authoritativeOnly?: boolean;
  } = {}
): Promise<IndependentEmbeddingCounterfactualCellMetrics> {
  const goldByQuestion = await loadGoldByQuestion(goldMapPath);
  const maxArtifactBytes = options.maxArtifactBytes ??
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES;
  const authoritativeOnly = options.authoritativeOnly ?? true;
  const acc = createCounterfactualCellAccumulator();
  let hardError: Error | null = null;

  const { recordCount } = await forEachSelectionBoundaryGzipRecord(
    artifactPath,
    maxArtifactBytes,
    COUNTERFACTUAL_ARTIFACT_ERRORS,
    (record) => {
      if (hardError !== null) return;
      if (authoritativeOnly && !record.authoritative) return;
      try {
        accumulateCounterfactualRecord(
          acc,
          evaluateCounterfactualRecord(record, goldByQuestion, options)
        );
      } catch (error) {
        hardError = error instanceof Error ? error : new Error(String(error));
      }
    }
  );

  if (hardError !== null) throw hardError;
  return rollupCounterfactualCellMetrics(
    acc,
    recordCount,
    authoritativeOnly
  );
}

export function resolveIndependentEmbeddingPromoteReady(
  cellA: IndependentEmbeddingCounterfactualCellMetrics,
  cellB: IndependentEmbeddingCounterfactualCellMetrics
): Readonly<{
  readonly promoteReady: boolean;
  readonly blockers: readonly string[];
}> {
  const blockers: string[] = [];
  if (!cellA.nonRegressive) blockers.push("cell_a_regressive_or_incomplete");
  if (!cellB.nonRegressive) blockers.push("cell_b_regressive_or_incomplete");
  if (cellA.anyAt5Gain + cellB.anyAt5Gain <= 0) {
    blockers.push("no_positive_cell");
  }
  return Object.freeze({
    promoteReady: blockers.length === 0,
    blockers: Object.freeze(blockers)
  });
}

function evaluateCounterfactualRecord(
  record: SelectionBoundaryArtifactRecord,
  goldByQuestion: ReadonlyMap<string, GoldQuestion>,
  options: SelectionCompositionOptions
): CounterfactualRecordEvaluation {
  reconstructFineAssessmentComposition(record.boundary, {
    finalAuthorityMaxHeadDrop: options.finalAuthorityMaxHeadDrop
  });
  const baselineKeys = record.boundary.expected.candidate_keys;
  let counterfactualKeys: readonly string[] | null = null;
  let unseenTokenFailure = false;
  try {
    const reconstructed = reconstructIndependentEmbeddingEvidenceComposition(
      record.boundary,
      { finalAuthorityMaxHeadDrop: options.finalAuthorityMaxHeadDrop }
    );
    counterfactualKeys = counterfactualDeliveredCandidateKeys(
      reconstructed.result
    );
  } catch (error) {
    if (!isUnseenTokenFailure(error)) throw error;
    unseenTokenFailure = true;
  }
  const gold = goldByQuestion.get(record.question_id);
  if (gold === undefined) {
    throw new Error(
      `selection counterfactual missing gold map entry for ${record.question_id}`
    );
  }
  return Object.freeze({
    baselineKeys,
    counterfactualKeys,
    unseenTokenFailure,
    answerable: gold.answerable,
    goldObjectIds: gold.goldObjectIds
  });
}

function accumulateCounterfactualRecord(
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

function rollupCounterfactualCellMetrics(
  acc: CounterfactualCellAccumulator,
  recordCount: number,
  authoritativeOnly: boolean
): IndependentEmbeddingCounterfactualCellMetrics {
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
    operator: INDEPENDENT_EMBEDDING_EVIDENCE_OPERATOR,
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

function createCounterfactualCellAccumulator(): CounterfactualCellAccumulator {
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

function isUnseenTokenFailure(error: unknown): boolean {
  return error instanceof Error &&
    error.message === SELECTION_BOUNDARY_FIDELITY_MISMATCH;
}

function sameMembership(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((key) => rightSet.has(key));
}

function sameOrder(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index]);
}

function objectIdFromCandidateKey(candidateKey: string): string {
  const parts = candidateKey.split(":");
  return parts[parts.length - 1]!;
}

function anyGoldInHead(
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

function fullGoldInHead(
  candidateKeys: readonly string[],
  goldObjectIds: readonly string[],
  head: number
): boolean {
  if (goldObjectIds.length === 0) return false;
  const delivered = new Set(
    candidateKeys.slice(0, head).map(objectIdFromCandidateKey)
  );
  return goldObjectIds.every((objectId) => delivered.has(objectId));
}

async function loadGoldByQuestion(
  goldMapPath: string
): Promise<ReadonlyMap<string, GoldQuestion>> {
  const payload = JSON.parse(await readFile(goldMapPath, "utf8")) as Readonly<{
    readonly questions: readonly Readonly<{
      readonly question_id: string;
      readonly is_abstention: boolean;
      readonly premise_invalid: boolean;
      readonly gold_object_ids: readonly string[];
    }>[];
  }>;
  return new Map(payload.questions.map((question) => [
    question.question_id,
    Object.freeze({
      answerable: !question.is_abstention && !question.premise_invalid,
      goldObjectIds: Object.freeze([...question.gold_object_ids])
    })
  ]));
}
