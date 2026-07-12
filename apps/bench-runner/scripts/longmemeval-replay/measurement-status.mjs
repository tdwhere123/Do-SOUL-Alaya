export function isScorableMeasurementCohort(cohort) {
  if (cohort?.measurement_status !== undefined) {
    return cohort.measurement_status === "scorable";
  }
  return cohort != null &&
    (cohort.dataset_cohort === undefined || cohort.dataset_cohort === "answerable") &&
    cohort.evaluator_gold_identity?.status === "present" &&
    cohort.evaluator_gold_identity.object_ids?.length > 0 &&
    cohort.extraction_materialization?.status !== "drop" &&
    cohort.evaluation_issue_reason == null;
}

export function measurementUnscorableReason(cohort) {
  if (cohort?.measurement_status !== undefined) return cohort.measurement_status;
  if (cohort?.dataset_cohort === "abstention") return "abstention_unscorable";
  if (cohort?.evaluation_issue_reason != null) return cohort.evaluation_issue_reason;
  return "evaluator_identity_unscorable";
}
