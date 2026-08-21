import type {
  TreatmentCompositionStatus,
  TreatmentExposureReceipt,
  TreatmentExposureStatus,
  TreatmentFormationStatus
} from "./contract.js";
import {
  GATE7_CANARY_Q1,
  GATE7_CANARY_Q2,
  GATE7_CANARY_Q3,
  GATE7_CANARY_QUESTION_IDS,
  normalizeGate7CanaryQuestionId,
  type Gate7CanaryQuestionId
} from "./gate7-canary-ids.js";

export type Gate7ExpectedPolarity = "positive" | "negative";

export interface Gate7PolarityExpectation {
  readonly question_id: Gate7CanaryQuestionId;
  readonly expected_polarity: Gate7ExpectedPolarity;
  readonly reason: string;
  readonly formation: "formed";
  readonly compatible_count: { readonly min?: number; readonly exact?: number };
  readonly composition: TreatmentCompositionStatus;
  readonly activation: TreatmentCompositionStatus;
  readonly exposure: TreatmentExposureStatus;
}

export const GATE7_POLARITY_EXPECTATIONS: readonly Gate7PolarityExpectation[] = [
  {
    question_id: GATE7_CANARY_Q1,
    expected_polarity: "positive",
    reason: "formed_compatible_composed_exposed",
    formation: "formed",
    compatible_count: { min: 1 },
    composition: "composed",
    activation: "composed",
    exposure: "exposed"
  },
  {
    question_id: GATE7_CANARY_Q2,
    expected_polarity: "negative",
    reason: "source_bound_subject_uncovered",
    formation: "formed",
    compatible_count: { exact: 0 },
    composition: "no_match",
    activation: "no_match",
    exposure: "not_exercised"
  },
  {
    question_id: GATE7_CANARY_Q3,
    expected_polarity: "negative",
    reason: "no_formed_location_join_partner",
    formation: "formed",
    compatible_count: { exact: 0 },
    composition: "no_match",
    activation: "no_match",
    exposure: "not_exercised"
  }
];

export interface Gate7ObservedPolarity {
  readonly formation: TreatmentFormationStatus;
  readonly compatible_count: number;
  readonly composition: TreatmentCompositionStatus;
  readonly activation: TreatmentCompositionStatus;
  readonly exposure: TreatmentExposureStatus;
}

export interface Gate7PolarityRow {
  readonly question_id: string;
  readonly expected_polarity: Gate7ExpectedPolarity | null;
  readonly expected_reason: string | null;
  readonly observed: Gate7ObservedPolarity | null;
  readonly verdict: "pass" | "fail";
  readonly failure_reason: string | null;
  readonly failure_reasons: readonly string[];
}

export interface Gate7PolarityMatrixVerdict {
  readonly schema_version: 1;
  readonly kind: "gate7_canary_polarity_matrix";
  readonly applicable: boolean;
  readonly passed: boolean;
  readonly reason: "gate7_polarity_matrix_passed" | "gate7_polarity_matrix_failed" |
    "not_gate7_canary_window";
  readonly rows: readonly Gate7PolarityRow[];
  readonly failure_reasons: readonly string[];
}

export function evaluateGate7PolarityMatrix(
  receipts: readonly TreatmentExposureReceipt[]
): Gate7PolarityMatrixVerdict {
  if (receipts.length !== GATE7_CANARY_QUESTION_IDS.length) {
    return notApplicableMatrix();
  }
  const windowFailures = collectWindowFailures(receipts);
  if (windowFailures.length > 0) {
    return failedMatrix(windowFailures, windowFailureRows(receipts, windowFailures));
  }
  const rows = GATE7_POLARITY_EXPECTATIONS.map((expectation) =>
    evaluateExpectedRow(expectation, requireReceipt(receipts, expectation.question_id))
  );
  const failure_reasons = rows.flatMap((row) => row.failure_reasons);
  return failure_reasons.length === 0
    ? passedMatrix(rows)
    : failedMatrix(failure_reasons, rows);
}

function collectWindowFailures(receipts: readonly TreatmentExposureReceipt[]): string[] {
  const normalized = receipts.map((receipt) => normalizeGate7CanaryQuestionId(receipt.question_id));
  const failures: string[] = [];
  if (new Set(normalized).size !== normalized.length) failures.push("duplicate_question");
  for (const questionId of GATE7_CANARY_QUESTION_IDS) {
    if (!normalized.includes(questionId)) failures.push(`missing_question:${questionId}`);
  }
  for (const questionId of normalized) {
    if (!(GATE7_CANARY_QUESTION_IDS as readonly string[]).includes(questionId)) {
      failures.push(`unknown_question:${questionId}`);
    }
  }
  return failures;
}

function evaluateExpectedRow(
  expectation: Gate7PolarityExpectation,
  receipt: TreatmentExposureReceipt
): Gate7PolarityRow {
  const observed = observedPolarity(receipt);
  const failure_reasons = polarityFailures(expectation, observed);
  return {
    question_id: expectation.question_id,
    expected_polarity: expectation.expected_polarity,
    expected_reason: expectation.reason,
    observed,
    verdict: failure_reasons.length === 0 ? "pass" : "fail",
    failure_reason: failure_reasons[0] ?? null,
    failure_reasons
  };
}

function polarityFailures(
  expectation: Gate7PolarityExpectation,
  observed: Gate7ObservedPolarity
): string[] {
  const reasons: string[] = [];
  if (observed.formation !== expectation.formation) {
    reasons.push(`${expectation.question_id}:formation`);
  }
  if (!compatibleCountMatches(expectation.compatible_count, observed.compatible_count)) {
    reasons.push(`${expectation.question_id}:compatible_count`);
  }
  if (observed.composition !== expectation.composition) {
    reasons.push(`${expectation.question_id}:composition`);
  }
  if (observed.activation !== expectation.activation) {
    reasons.push(`${expectation.question_id}:activation`);
  }
  if (observed.exposure !== expectation.exposure) {
    reasons.push(`${expectation.question_id}:exposure`);
  }
  return reasons;
}

function compatibleCountMatches(
  expected: Gate7PolarityExpectation["compatible_count"],
  actual: number
): boolean {
  if (expected.exact !== undefined) return actual === expected.exact;
  return expected.min !== undefined && actual >= expected.min;
}

function observedPolarity(receipt: TreatmentExposureReceipt): Gate7ObservedPolarity {
  return {
    formation: receipt.formation.status,
    compatible_count: receipt.compatible_evidence.compatible_count,
    composition: receipt.composition.status,
    activation: receipt.activation.status,
    exposure: receipt.exposure_status
  };
}

function requireReceipt(
  receipts: readonly TreatmentExposureReceipt[],
  questionId: Gate7CanaryQuestionId
): TreatmentExposureReceipt {
  return receipts.find((receipt) =>
    normalizeGate7CanaryQuestionId(receipt.question_id) === questionId
  )!;
}

function windowFailureRows(
  receipts: readonly TreatmentExposureReceipt[],
  failureReasons: readonly string[]
): Gate7PolarityRow[] {
  return receipts.map((receipt) => ({
    question_id: normalizeGate7CanaryQuestionId(receipt.question_id),
    expected_polarity: null,
    expected_reason: null,
    observed: observedPolarity(receipt),
    verdict: "fail" as const,
    failure_reason: failureReasons[0] ?? "invalid_gate7_window",
    failure_reasons: failureReasons
  }));
}

function passedMatrix(rows: readonly Gate7PolarityRow[]): Gate7PolarityMatrixVerdict {
  return {
    schema_version: 1,
    kind: "gate7_canary_polarity_matrix",
    applicable: true,
    passed: true,
    reason: "gate7_polarity_matrix_passed",
    rows,
    failure_reasons: []
  };
}

function failedMatrix(
  failure_reasons: readonly string[],
  rows: readonly Gate7PolarityRow[]
): Gate7PolarityMatrixVerdict {
  return {
    schema_version: 1,
    kind: "gate7_canary_polarity_matrix",
    applicable: true,
    passed: false,
    reason: "gate7_polarity_matrix_failed",
    rows,
    failure_reasons
  };
}

function notApplicableMatrix(): Gate7PolarityMatrixVerdict {
  return {
    schema_version: 1,
    kind: "gate7_canary_polarity_matrix",
    applicable: false,
    passed: false,
    reason: "not_gate7_canary_window",
    rows: [],
    failure_reasons: []
  };
}
