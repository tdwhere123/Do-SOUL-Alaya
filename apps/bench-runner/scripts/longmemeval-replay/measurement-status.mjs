const DATASET_COHORTS = new Set(["answerable", "abstention", "adjudicated_invalid"]);
const MEASUREMENT_STATUSES = new Set([
  "scorable", "abstention_unscorable", "evaluator_identity_unscorable"
]);
const EVALUATOR_STATUSES = new Set(["present", "absent", "ambiguous"]);
const MATERIALIZATION_STATUSES = new Set(["memory_emitted", "drop", "unknown"]);
const EVALUATION_ISSUES = new Set([
  "missing_diagnostics", "empty_gold_identity", "extraction_materialization_drop",
  "gold_taxonomy_fallthrough", "identity_join_error",
  "evaluator_data_identity_inconsistency", "evaluator_data_identity_indeterminate",
  "adjudicated_dataset_issue"
]);

export function deriveQuestionMeasurementStatus(input) {
  const ledger = validateQuestionMeasurementPrimitives(
    input?.cohortLedger,
    input?.legacyDiagnostic === true
  );
  if (ledger.dataset_cohort === "abstention") return "abstention_unscorable";
  return hasScorableAnswerableEvidence(ledger)
    ? "scorable"
    : "evaluator_identity_unscorable";
}

export function validateQuestionMeasurementStatus(input) {
  const derived = deriveQuestionMeasurementStatus(input);
  const persisted = input.cohortLedger.measurement_status;
  if (persisted !== undefined && persisted !== derived) {
    throw new Error("persisted measurement status contradicts primitive axes");
  }
  return derived;
}

export function isScorableMeasurementCohort(cohort, isAbstention = false) {
  return validateQuestionMeasurementStatus({
    isAbstention,
    cohortLedger: cohort
  }) === "scorable";
}

export function measurementUnscorableReason(cohort, isAbstention = false) {
  const status = validateQuestionMeasurementStatus({
    isAbstention,
    cohortLedger: cohort
  });
  if (status === "abstention_unscorable") return status;
  if (cohort?.evaluation_issue_reason != null) return cohort.evaluation_issue_reason;
  return status;
}

function hasScorableAnswerableEvidence(ledger) {
  if (ledger.dataset_cohort !== "answerable") return false;
  return hasEmittedGoldIdentity(ledger) || hasVerifiedExtractionFailure(ledger);
}

function hasEmittedGoldIdentity(ledger) {
  return ledger.evaluator_gold_identity?.status === "present" &&
    ledger.evaluator_gold_identity.object_ids?.length > 0 &&
    ledger.extraction_materialization?.status === "memory_emitted" &&
    ledger.evaluation_issue_reason === null;
}

function hasVerifiedExtractionFailure(ledger) {
  return ledger.evaluator_gold_identity?.status === "absent" &&
    ledger.evaluator_gold_identity.object_ids?.length === 0 &&
    ledger.extraction_materialization?.status === "drop" &&
    ["candidate_absent", "materialization_drop"].includes(
      ledger.extraction_materialization.reason
    ) &&
    ledger.evaluation_issue_reason === "extraction_materialization_drop";
}

function validateQuestionMeasurementPrimitives(ledger, legacyDiagnostic) {
  if (!isObject(ledger)) throw new Error("current cohortLedger must be an object");
  if (ledger.measurement_evidence_mode === "legacy_synthesized" && !legacyDiagnostic) {
    throw new Error("legacy synthesized measurement evidence requires explicit diagnostic opt-in");
  }
  if (ledger.measurement_evidence_mode !== undefined &&
      ledger.measurement_evidence_mode !== "legacy_synthesized") {
    throw new Error("invalid measurement_evidence_mode");
  }
  validateRequiredEnum(ledger.dataset_cohort, DATASET_COHORTS, "dataset_cohort");
  validateOptionalEnum(ledger.measurement_status, MEASUREMENT_STATUSES, "measurement_status");
  validateEvaluatorIdentity(ledger.evaluator_gold_identity);
  validateMaterialization(ledger.extraction_materialization, ledger.evaluator_gold_identity);
  if (!Object.hasOwn(ledger, "evaluation_issue_reason")) {
    throw new Error("missing required evaluation_issue_reason");
  }
  const issue = ledger.evaluation_issue_reason;
  if (issue !== null && !EVALUATION_ISSUES.has(issue))
    throw new Error("invalid evaluation_issue_reason");
  return ledger;
}

function validateEvaluatorIdentity(identity) {
  if (!isObject(identity) || !EVALUATOR_STATUSES.has(identity.status)) {
    throw new Error("invalid evaluator_gold_identity.status");
  }
  if (!Array.isArray(identity.object_ids) ||
      identity.object_ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("evaluator_gold_identity.object_ids must be an array of IDs");
  }
}

function validateMaterialization(materialization, identity) {
  if (!isObject(materialization) || !MATERIALIZATION_STATUSES.has(materialization.status)) {
    throw new Error("invalid extraction_materialization.status");
  }
  const count = materialization.emitted_memory_count;
  const reason = materialization.reason;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid extraction_materialization.emitted_memory_count");
  }
  if (materialization.status === "memory_emitted") {
    if (count === 0 || count !== identity.object_ids.length || reason !== null) {
      throw new Error("invalid extraction_materialization memory_emitted tuple");
    }
    return;
  }
  if (materialization.status === "drop") {
    if (count !== 0 || !["candidate_absent", "materialization_drop"].includes(reason)) {
      throw new Error("invalid extraction_materialization drop tuple");
    }
    return;
  }
  if (count !== 0 || reason !== null) {
    throw new Error("invalid extraction_materialization unknown tuple");
  }
}

function validateOptionalEnum(value, allowed, field) {
  if (value !== undefined && !allowed.has(value)) throw new Error(`invalid ${field}`);
}

function validateRequiredEnum(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(`missing or invalid ${field}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
