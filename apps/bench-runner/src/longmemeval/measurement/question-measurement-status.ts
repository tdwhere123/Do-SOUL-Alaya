import {
  deriveQuestionMeasurementStatus as deriveRuntimeMeasurementStatus,
  validateQuestionMeasurementStatus as validateRuntimeMeasurementStatus
} from "../../../scripts/longmemeval-replay/measurement-status.mjs";

export type QuestionMeasurementStatus =
  | "scorable"
  | "abstention_unscorable"
  | "evaluator_identity_unscorable";

export interface QuestionMeasurementPrimitiveLedger {
  readonly measurement_evidence_mode?: "legacy_synthesized";
  readonly measurement_status?: QuestionMeasurementStatus;
  readonly dataset_cohort: "answerable" | "abstention" | "adjudicated_invalid";
  readonly evaluator_gold_identity: {
    readonly status: "present" | "absent" | "ambiguous";
    readonly object_ids: readonly string[];
  };
  readonly extraction_materialization: {
    readonly status: "memory_emitted" | "drop" | "unknown";
    readonly emitted_memory_count: number;
    readonly reason: "candidate_absent" | "materialization_drop" | null;
  };
  readonly evaluation_issue_reason: string | null;
}

interface QuestionMeasurementStatusInput {
  readonly isAbstention: boolean;
  readonly legacyDiagnostic?: boolean;
  readonly cohortLedger: QuestionMeasurementPrimitiveLedger;
}

export function deriveQuestionMeasurementStatus(
  input: QuestionMeasurementStatusInput
): QuestionMeasurementStatus {
  return deriveRuntimeMeasurementStatus(input);
}

export function validateQuestionMeasurementStatus(
  input: QuestionMeasurementStatusInput
): QuestionMeasurementStatus {
  return validateRuntimeMeasurementStatus(input);
}
