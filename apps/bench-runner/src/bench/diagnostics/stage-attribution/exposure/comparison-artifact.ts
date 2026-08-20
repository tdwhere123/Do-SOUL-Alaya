import { readFile } from "node:fs/promises";
import {
  assertTreatmentExposureReceipt,
  CACHED_F3_EXPOSURE_POLICY,
  type TreatmentExposureReceipt,
  type TreatmentExposureStage
} from "./contract.js";
import type { Diagnostic100QComparison } from "../diagnostic-100q.js";

const STAGES: readonly TreatmentExposureStage[] = ["S0", "S1", "S2", "S3", "S4", "S5"];

export async function readDiagnostic100QComparisonArtifact(
  path: string
): Promise<Diagnostic100QComparison> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertComparison(value);
  return value;
}

function assertComparison(value: unknown): asserts value is Diagnostic100QComparison {
  if (!isComparisonShape(value)) {
    throw new Error("diagnostic 100Q artifact lacks the cached F3 exposure contract");
  }
  const receipts = value.treatment_exposure_receipts as unknown[];
  receipts.forEach(assertTreatmentExposureReceipt);
  const typedReceipts = receipts as TreatmentExposureReceipt[];
  assertUniqueQuestionIds(typedReceipts);
  assertGateAndStatus(value, typedReceipts);
  assertClassifications(value, typedReceipts);
  assertStageCounts(value, typedReceipts);
}

function isComparisonShape(value: unknown): value is Diagnostic100QComparison {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "kind", "physical_calls", "five_hundred_q_closed",
    "control_misses", "treatment_misses", "membership_improved", "still_missing",
    "not_exercised", "inconclusive", "treatment_exposure_receipts",
    "causal_comparison_status", "exposed_denominator_gate"
  ])) return false;
  return value.schema_version === 5 &&
    value.kind === "diagnostic_100q_f0f2_vs_cached_f3" &&
    value.physical_calls === 0 && value.five_hundred_q_closed === true &&
    isStageCounts(value.control_misses) && isStageCounts(value.treatment_misses) &&
    isSortedUniqueStrings(value.membership_improved) &&
    isSortedUniqueStrings(value.still_missing) &&
    isSortedUniqueStrings(value.not_exercised) &&
    isSortedUniqueStrings(value.inconclusive) &&
    Array.isArray(value.treatment_exposure_receipts) &&
    (value.causal_comparison_status === "eligible" ||
      value.causal_comparison_status === "inconclusive") &&
    isExposureGate(value.exposed_denominator_gate);
}

function assertGateAndStatus(
  comparison: Diagnostic100QComparison,
  receipts: readonly TreatmentExposureReceipt[]
): void {
  const exposedCount = receipts.filter((row) => row.exposure_status === "exposed").length;
  const rate = receipts.length === 0 ? 0 : exposedCount / receipts.length;
  const gate = comparison.exposed_denominator_gate;
  if (gate.declared_minimum_rate !== CACHED_F3_EXPOSURE_POLICY.declared_minimum_rate) {
    throw new Error("diagnostic 100Q exposed denominator does not match current exposure policy");
  }
  const passed = receipts.length > 0 && rate >= gate.declared_minimum_rate;
  if (gate.evaluated_count !== receipts.length || gate.exposed_count !== exposedCount ||
      gate.actual_rate !== rate || gate.passed !== passed ||
      comparison.causal_comparison_status !== (passed ? "eligible" : "inconclusive")) {
    throw new Error("diagnostic 100Q exposed denominator does not match its receipts");
  }
}

function assertClassifications(
  comparison: Diagnostic100QComparison,
  receipts: readonly TreatmentExposureReceipt[]
): void {
  const expected = {
    membership_improved: [] as string[],
    still_missing: [] as string[],
    not_exercised: [] as string[],
    inconclusive: [] as string[]
  };
  for (const receipt of receipts) classifyReceipt(expected, receipt);
  for (const key of Object.keys(expected) as readonly (keyof typeof expected)[]) {
    if (!sameStrings(comparison[key], expected[key])) {
      throw new Error("diagnostic 100Q classifications do not match its receipts");
    }
  }
}

function classifyReceipt(
  output: Record<"membership_improved" | "still_missing" |
    "not_exercised" | "inconclusive", string[]>,
  receipt: TreatmentExposureReceipt
): void {
  const questionId = receipt.question_id;
  if (receipt.exposure_status === "not_exercised") output.not_exercised.push(questionId);
  else if (receipt.exposure_status === "inconclusive") output.inconclusive.push(questionId);
  else if (!receipt.outcome.control.hit_at_5 && receipt.outcome.treatment.hit_at_5) {
    output.membership_improved.push(questionId);
  } else if (!receipt.outcome.control.hit_at_5 && !receipt.outcome.treatment.hit_at_5) {
    output.still_missing.push(questionId);
  }
}

function assertStageCounts(
  comparison: Diagnostic100QComparison,
  receipts: readonly TreatmentExposureReceipt[]
): void {
  const control = emptyStageCounts();
  const treatment = emptyStageCounts();
  for (const receipt of receipts) {
    if (!receipt.outcome.control.hit_at_5) control[receipt.outcome.control.stage] += 1;
    if (!receipt.outcome.treatment.hit_at_5) treatment[receipt.outcome.treatment.stage] += 1;
  }
  if (!sameStageCounts(comparison.control_misses, control) ||
      !sameStageCounts(comparison.treatment_misses, treatment)) {
    throw new Error("diagnostic 100Q stage counts do not match its receipts");
  }
}

function assertUniqueQuestionIds(receipts: readonly TreatmentExposureReceipt[]): void {
  const ids = receipts.map((receipt) => receipt.question_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("diagnostic 100Q contains duplicate treatment exposure receipts");
  }
}

function isExposureGate(value: unknown): value is Diagnostic100QComparison["exposed_denominator_gate"] {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version", "kind", "declared_minimum_rate", "evaluated_count",
    "exposed_count", "actual_rate", "passed"
  ])) return false;
  return value.schema_version === 1 && value.kind === "cached_f3_exposed_denominator_gate" &&
    isRate(value.declared_minimum_rate) && isCount(value.evaluated_count) &&
    isCount(value.exposed_count) && isRate(value.actual_rate) &&
    typeof value.passed === "boolean";
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isStageCounts(value: unknown): value is Readonly<Record<TreatmentExposureStage, number>> {
  return isRecord(value) && hasExactKeys(value, STAGES) &&
    STAGES.every((stage) => isCount(value[stage]));
}

function emptyStageCounts(): Record<TreatmentExposureStage, number> {
  return { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };
}

function sameStageCounts(
  left: Readonly<Record<TreatmentExposureStage, number>>,
  right: Readonly<Record<TreatmentExposureStage, number>>
): boolean {
  return STAGES.every((stage) => left[stage] === right[stage]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === [...right].sort()[index]);
}

function isSortedUniqueStrings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !value.every((item) =>
    typeof item === "string" && item.trim().length > 0)) return false;
  return value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
