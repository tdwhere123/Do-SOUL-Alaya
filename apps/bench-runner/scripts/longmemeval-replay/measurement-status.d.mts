export type RuntimeQuestionMeasurementStatus =
  | "scorable"
  | "abstention_unscorable"
  | "evaluator_identity_unscorable";

export interface RuntimeQuestionMeasurementPrimitiveLedger {
  readonly measurement_evidence_mode?: "legacy_synthesized";
  readonly measurement_status?: RuntimeQuestionMeasurementStatus;
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

export interface RuntimeQuestionMeasurementStatusInput {
  readonly isAbstention: boolean;
  readonly legacyDiagnostic?: boolean;
  readonly cohortLedger: RuntimeQuestionMeasurementPrimitiveLedger;
}

export function deriveQuestionMeasurementStatus(
  input: RuntimeQuestionMeasurementStatusInput
): RuntimeQuestionMeasurementStatus;

export function validateQuestionMeasurementStatus(
  input: RuntimeQuestionMeasurementStatusInput
): RuntimeQuestionMeasurementStatus;

export function isScorableMeasurementCohort(
  cohort?: unknown,
  isAbstention?: boolean
): boolean;

export function measurementUnscorableReason(
  cohort?: unknown,
  isAbstention?: boolean
): string;
