import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  compareGoldRow,
  comparePrefixRow,
  isGoldExclusionOutcome,
  isGoldExclusionReason,
  buildRecallMechanismSplit
} from "./receipt.js";
import {
  hasExactKeys,
  isNonEmptyString,
  isRecord,
  isSortedUniqueStrings
} from "./json-shape.js";
import {
  MECHANISM_PREFIX_OPERATOR_ID,
  RECALL_MECHANISM_SPLIT_KIND,
  RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
  type GoldExclusionRow,
  type MechanismQuestionIds,
  type MechanismQuestionObservation,
  type PrefixEligibilityRow,
  type RecallMechanismSplitReceipt
} from "./types.js";

const RECEIPT_KEYS = Object.freeze([
  "schema_version", "kind", "prefix_operator_id", "questions",
  "field_member_added", "compatibility_added", "binding_solution_added",
  "activation_changed", "fused_rank_changed", "gamma_admission_changed",
  "delivered_hit_changed", "gold_exclusions", "bounded_candidate_prefix"
]);

export async function readRecallMechanismSplitArtifact(
  path: string
): Promise<RecallMechanismSplitReceipt> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertRecallMechanismSplitReceipt(value);
  return value;
}

export function assertRecallMechanismSplitReceipt(
  value: unknown
): asserts value is RecallMechanismSplitReceipt {
  if (isComparisonArtifact(value)) {
    throw new Error(
      "diagnostic 100Q comparison cannot be reinterpreted as a recall mechanism split"
    );
  }
  if (!isMechanismShape(value)) {
    throw new Error("recall mechanism split artifact lacks the v1 contract");
  }
  const rebuilt = buildRecallMechanismSplit({ questions: value.questions });
  if (!isDeepStrictEqual(value, rebuilt)) {
    throw new Error("recall mechanism split classifications do not match its observations");
  }
}

function isComparisonArtifact(value: unknown): boolean {
  return isRecord(value) && value.kind === "diagnostic_100q_f0f2_vs_cached_f3";
}

function isMechanismShape(value: unknown): value is RecallMechanismSplitReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false;
  return value.schema_version === RECALL_MECHANISM_SPLIT_SCHEMA_VERSION &&
    value.kind === RECALL_MECHANISM_SPLIT_KIND &&
    value.prefix_operator_id === MECHANISM_PREFIX_OPERATOR_ID &&
    isQuestions(value.questions) &&
    isMechanismField(value.field_member_added) &&
    isMechanismField(value.compatibility_added) &&
    isMechanismField(value.binding_solution_added) &&
    isMechanismField(value.activation_changed) &&
    isMechanismField(value.fused_rank_changed) &&
    isMechanismField(value.gamma_admission_changed) &&
    isMechanismField(value.delivered_hit_changed) &&
    isGoldExclusionRows(value.gold_exclusions) &&
    isPrefixRows(value.bounded_candidate_prefix);
}

function isQuestions(
  value: unknown
): value is readonly MechanismQuestionObservation[] {
  return Array.isArray(value) && value.every((question) =>
    isRecord(question) && isNonEmptyString(question.question_id));
}

function isMechanismField(value: unknown): value is MechanismQuestionIds {
  return value === "unavailable" || isSortedUniqueStrings(value);
}

function isGoldExclusionRows(value: unknown): value is readonly GoldExclusionRow[] {
  if (!Array.isArray(value) || !value.every(isGoldExclusionRow)) return false;
  return isStrictlySorted(value, compareGoldRow);
}

function isPrefixRows(value: unknown): value is readonly PrefixEligibilityRow[] {
  if (!Array.isArray(value) || !value.every(isPrefixRow)) return false;
  return isStrictlySorted(value, comparePrefixRow);
}

function isGoldExclusionRow(value: unknown): value is GoldExclusionRow {
  return isRecord(value) &&
    hasExactKeys(value, ["question_id", "gold_key", "first_reason", "outcome"]) &&
    isNonEmptyString(value.question_id) && isNonEmptyString(value.gold_key) &&
    isGoldExclusionReason(value.first_reason) &&
    isGoldExclusionOutcome(value.outcome);
}

function isPrefixRow(value: unknown): value is PrefixEligibilityRow {
  return isRecord(value) && hasExactKeys(value, ["question_id", "candidate_key", "eligible"]) &&
    isNonEmptyString(value.question_id) && isNonEmptyString(value.candidate_key) &&
    (value.eligible === true || value.eligible === false || value.eligible === "unavailable");
}

function isStrictlySorted<T>(
  rows: readonly T[],
  compare: (left: T, right: T) => number
): boolean {
  return rows.every((row, index) => index === 0 || compare(rows[index - 1]!, row) < 0);
}
