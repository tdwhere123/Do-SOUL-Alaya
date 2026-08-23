import { readFile } from "node:fs/promises";
import {
  GOLD_EXCLUSION_FIRST_REASONS,
  RECALL_MECHANISM_SPLIT_KIND,
  RECALL_MECHANISM_SPLIT_SCHEMA_VERSION,
  type GoldExclusionRow,
  type MechanismQuestionIds,
  type PrefixEligibilityRow,
  type RecallMechanismSplitReceipt
} from "./mechanism-receipt.js";

const RECEIPT_KEYS = Object.freeze([
  "schema_version", "kind", "field_member_added", "compatibility_added",
  "binding_solution_added", "activation_changed", "fused_rank_changed",
  "gamma_admission_changed", "delivered_hit_changed", "gold_exclusions",
  "bounded_candidate_prefix"
]);
const FIRST_REASON_SET = new Set<string>(GOLD_EXCLUSION_FIRST_REASONS);

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
}

function isComparisonArtifact(value: unknown): boolean {
  return isRecord(value) && (
    value.kind === "diagnostic_100q_f0f2_vs_cached_f3" ||
    value.schema_version === 5 ||
    (value.schema_version === 6 && value.kind !== RECALL_MECHANISM_SPLIT_KIND)
  );
}

function isMechanismShape(value: unknown): value is RecallMechanismSplitReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false;
  return value.schema_version === RECALL_MECHANISM_SPLIT_SCHEMA_VERSION &&
    value.kind === RECALL_MECHANISM_SPLIT_KIND &&
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
  return isRecord(value) && hasExactKeys(value, ["question_id", "gold_key", "first_reason"]) &&
    isNonEmptyString(value.question_id) && isNonEmptyString(value.gold_key) &&
    (value.first_reason === "unavailable" || FIRST_REASON_SET.has(value.first_reason as string));
}

function isPrefixRow(value: unknown): value is PrefixEligibilityRow {
  return isRecord(value) && hasExactKeys(value, ["question_id", "candidate_key", "eligible"]) &&
    isNonEmptyString(value.question_id) && isNonEmptyString(value.candidate_key) &&
    (value.eligible === true || value.eligible === false || value.eligible === "unavailable");
}

function compareGoldRow(left: GoldExclusionRow, right: GoldExclusionRow): number {
  return comparePair(left.question_id, left.gold_key, right.question_id, right.gold_key);
}

function comparePrefixRow(left: PrefixEligibilityRow, right: PrefixEligibilityRow): number {
  return comparePair(
    left.question_id, left.candidate_key, right.question_id, right.candidate_key
  );
}

function comparePair(
  leftId: string, leftKey: string, rightId: string, rightKey: string
): number {
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

function isStrictlySorted<T>(
  rows: readonly T[],
  compare: (left: T, right: T) => number
): boolean {
  return rows.every((row, index) => index === 0 || compare(rows[index - 1]!, row) < 0);
}

function isSortedUniqueStrings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false;
  return value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
