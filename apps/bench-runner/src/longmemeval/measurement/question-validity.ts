import type { LongMemEvalQuestionDiagnostic } from "../diagnostics-types.js";

export type QuestionMeasurementStatus =
  | "scorable"
  | "abstention_unscorable"
  | "evaluator_identity_unscorable";

export function classifyQuestionMeasurementStatus(
  diagnostic: LongMemEvalQuestionDiagnostic
): QuestionMeasurementStatus {
  const ledger = diagnostic.cohort_ledger;
  const persisted = ledger?.measurement_status;
  if (persisted !== undefined) return persisted;
  if (ledger?.dataset_cohort === "abstention") return "abstention_unscorable";
  if (ledger?.dataset_cohort !== undefined) {
    return hasValidEvaluatorIdentity(diagnostic)
      ? "scorable"
      : "evaluator_identity_unscorable";
  }
  if (diagnostic.is_abstention) return "abstention_unscorable";
  return hasValidEvaluatorIdentity(diagnostic)
    ? "scorable"
    : "evaluator_identity_unscorable";
}

export function isEvaluatorIdentityUnscorable(
  diagnostic: LongMemEvalQuestionDiagnostic
): boolean {
  return classifyQuestionMeasurementStatus(diagnostic) ===
    "evaluator_identity_unscorable";
}

function hasValidEvaluatorIdentity(
  diagnostic: LongMemEvalQuestionDiagnostic
): boolean {
  const ledger = diagnostic.cohort_ledger;
  return ledger !== undefined &&
    (ledger.dataset_cohort === undefined || ledger.dataset_cohort === "answerable") &&
    ledger.evaluator_gold_identity?.status === "present" &&
    ledger.evaluator_gold_identity.object_ids.length > 0 &&
    ledger.extraction_materialization?.status !== "drop" &&
    ledger.evaluation_issue_reason === null;
}
