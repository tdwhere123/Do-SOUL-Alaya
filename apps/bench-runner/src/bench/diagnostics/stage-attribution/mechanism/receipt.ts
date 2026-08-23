import { classifyMechanismFields, goldOutcome, resolveFirstReason } from "./classify.js";
import { isNonEmptyString } from "./json-shape.js";
import {
  MECHANISM_PREFIX_OPERATOR_ID,
  RECALL_MECHANISM_SPLIT_KIND,
  RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
  type GoldExclusionRow,
  type MechanismQuestionObservation,
  type PrefixEligibility,
  type PrefixEligibilityRow,
  type RecallMechanismSplitInput,
  type RecallMechanismSplitReceipt
} from "./types.js";

export {
  GOLD_EXCLUSION_FIRST_REASONS,
  GOLD_EXCLUSION_OUTCOMES,
  MECHANISM_PREFIX_OPERATOR_ID,
  RECALL_MECHANISM_SPLIT_KIND,
  RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
  isGoldExclusionOutcome,
  isGoldExclusionReason
} from "./types.js";
export type {
  GoldExclusionFirstReason,
  GoldExclusionOutcome,
  GoldExclusionReason,
  GoldExclusionRow,
  GoldMechanismObservation,
  MechanismQuestionIds,
  MechanismQuestionObservation,
  PrefixEligibilityRow,
  RecallMechanismSplitInput,
  RecallMechanismSplitReceipt
} from "./types.js";

export function buildRecallMechanismSplit(
  input: RecallMechanismSplitInput
): RecallMechanismSplitReceipt {
  const questions = cloneQuestions(indexedQuestions(input.questions));
  return freezeDeep({
    schema_version: RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
    kind: RECALL_MECHANISM_SPLIT_KIND,
    prefix_operator_id: MECHANISM_PREFIX_OPERATOR_ID,
    questions,
    ...classifyMechanismFields(questions),
    gold_exclusions: freezeGoldExclusions(questions),
    bounded_candidate_prefix: freezePrefixRows(questions)
  });
}

export function compareGoldRow(left: GoldExclusionRow, right: GoldExclusionRow): number {
  return comparePair(left.question_id, left.gold_key, right.question_id, right.gold_key);
}

export function comparePrefixRow(
  left: PrefixEligibilityRow,
  right: PrefixEligibilityRow
): number {
  return comparePair(
    left.question_id, left.candidate_key, right.question_id, right.candidate_key
  );
}

function freezeGoldExclusions(
  questions: readonly MechanismQuestionObservation[]
): readonly GoldExclusionRow[] {
  const rows: GoldExclusionRow[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    for (const gold of question.golds ?? []) {
      const goldKey = requireToken(gold.gold_key, "gold_key");
      pushUnique(seen, pairKey(question.question_id, goldKey), "gold exclusion");
      const firstReason = resolveFirstReason(gold);
      rows.push({
        question_id: question.question_id,
        gold_key: goldKey,
        first_reason: firstReason,
        outcome: goldOutcome(gold, firstReason)
      });
    }
  }
  rows.sort(compareGoldRow);
  return rows;
}

function freezePrefixRows(
  questions: readonly MechanismQuestionObservation[]
): readonly PrefixEligibilityRow[] {
  const rowsByKey = new Map<string, PrefixEligibilityRow>();
  for (const question of questions) {
    for (const gold of question.golds ?? []) {
      if (gold.candidate_key === undefined) continue;
      appendPrefixRow(rowsByKey, question.question_id,
        gold.candidate_key, gold.prefix_eligible);
    }
    for (const candidate of question.candidates ?? []) {
      appendPrefixRow(rowsByKey, question.question_id,
        candidate.candidate_key, candidate.prefix_eligible);
    }
  }
  const rows = [...rowsByKey.values()];
  rows.sort(comparePrefixRow);
  return rows;
}

function appendPrefixRow(
  rowsByKey: Map<string, PrefixEligibilityRow>,
  questionId: string,
  candidateKey: string,
  eligible: PrefixEligibility | undefined
): void {
  const key = requireToken(candidateKey, "candidate_key");
  const rowKey = pairKey(questionId, key);
  const next: PrefixEligibilityRow = {
    question_id: questionId,
    candidate_key: key,
    eligible: eligible ?? "unavailable"
  };
  const existing = rowsByKey.get(rowKey);
  if (existing === undefined) {
    rowsByKey.set(rowKey, next);
    return;
  }
  if (existing.eligible === next.eligible) return;
  if (existing.eligible === "unavailable") {
    rowsByKey.set(rowKey, next);
    return;
  }
  if (next.eligible === "unavailable") return;
  throw new Error(`conflicting prefix eligibility: ${rowKey}`);
}

function indexedQuestions(
  questions: readonly MechanismQuestionObservation[]
): readonly MechanismQuestionObservation[] {
  const seen = new Set<string>();
  for (const question of questions) {
    const questionId = requireToken(question.question_id, "question_id");
    pushUnique(seen, questionId, "mechanism split question");
  }
  return questions;
}

function cloneQuestions(
  questions: readonly MechanismQuestionObservation[]
): readonly MechanismQuestionObservation[] {
  // Drop undefined optionals so artifact isDeepStrictEqual matches disk JSON.
  return JSON.parse(JSON.stringify(questions)) as MechanismQuestionObservation[];
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function comparePair(
  leftId: string, leftKey: string, rightId: string, rightKey: string
): number {
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function pushUnique(seen: Set<string>, key: string, label: string): void {
  if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`);
  seen.add(key);
}

function pairKey(questionId: string, key: string): string {
  return `${questionId}\0${key}`;
}

function requireToken(value: string, label: string): string {
  if (!isNonEmptyString(value)) throw new Error(`mechanism split ${label} is empty`);
  return value;
}
