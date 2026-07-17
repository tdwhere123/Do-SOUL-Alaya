import type { LongMemEvalQuestionDiagnostic } from "../diagnostics/schema/diagnostics-types.js";
import {
  validateQuestionMeasurementStatus,
  type QuestionMeasurementStatus
} from "./question-measurement-status.js";
export type { QuestionMeasurementStatus } from "./question-measurement-status.js";

export type QuestionMeasurementCohort =
  | "answerable"
  | "dataset_declared_abstention";

export function classifyQuestionMeasurementCohort(
  diagnostic: LongMemEvalQuestionDiagnostic
): QuestionMeasurementCohort {
  if (diagnostic.cohort_ledger?.measurement_evidence_mode === "legacy_synthesized") {
    throw new Error("legacy synthesized measurement evidence is not a current cohort");
  }
  const datasetCohort = diagnostic.cohort_ledger?.dataset_cohort;
  if (datasetCohort === "abstention") return "dataset_declared_abstention";
  if (datasetCohort === "answerable" || datasetCohort === "adjudicated_invalid") {
    return "answerable";
  }
  throw new Error(`Question ${diagnostic.question_id} has no current cohort ledger`);
}

export function classifyQuestionMeasurementStatus(
  diagnostic: LongMemEvalQuestionDiagnostic
): QuestionMeasurementStatus {
  if (diagnostic.cohort_ledger === undefined) {
    throw new Error(`Question ${diagnostic.question_id} has no current cohort ledger`);
  }
  return validateQuestionMeasurementStatus({
    isAbstention: diagnostic.is_abstention,
    cohortLedger: diagnostic.cohort_ledger
  });
}

export function isEvaluatorIdentityUnscorable(
  diagnostic: LongMemEvalQuestionDiagnostic
): boolean {
  return classifyQuestionMeasurementStatus(diagnostic) ===
    "evaluator_identity_unscorable";
}
