import type {
  BenchmarkMeasurementAttribution,
  KpiPayload
} from "@do-soul/alaya-eval";

export function buildBenchmarkMeasurementAttribution(input: {
  readonly candidatePoolComplete: boolean;
  readonly provenanceComplete: boolean;
  readonly abstention:
    NonNullable<KpiPayload["kpi"]["quality_metrics"]>["abstention"] | undefined;
  readonly noGoldCount?: number;
  readonly evaluatorIdentityIssueCount?: number;
  readonly evaluatorIdentityUnscorableCount?: number;
}): BenchmarkMeasurementAttribution {
  const hasCurrentAbstentionEvidence =
    input.abstention?.schema_version === "bench-abstention.v2";
  const evidenceComplete = input.candidatePoolComplete && input.provenanceComplete;
  const identityComplete = input.noGoldCount === 0 &&
    input.evaluatorIdentityIssueCount === 0 &&
    input.evaluatorIdentityUnscorableCount === 0;
  const eligible = evidenceComplete && hasCurrentAbstentionEvidence && identityComplete;
  return {
    schema_version: "bench-measurement-attribution.v3",
    status: eligible ? "eligible" : "ineligible",
    gate_eligible: eligible,
    evidence_status: evidenceComplete ? "complete" : "partial",
    candidate_pool_complete: input.candidatePoolComplete,
    provenance_complete: input.provenanceComplete,
    measurement_scope: "answerable_recall",
    abstention_evaluation_status: "excluded_not_evaluated",
    abstention_calibration_status: "uncalibrated",
    abstention_gate_eligible: false,
    abstention_evidence_status: hasCurrentAbstentionEvidence
      ? "current_uncalibrated"
      : "missing_or_legacy",
    evaluator_identity_status: identityComplete ? "complete" : "invalid"
  };
}
