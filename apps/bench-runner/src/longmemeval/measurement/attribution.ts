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
  const abstentionStatus = input.abstention?.schema_version === "bench-abstention.v2" &&
    input.abstention.total === 0
    ? "not_applicable" as const
    : "uncalibrated" as const;
  const evidenceComplete = input.candidatePoolComplete && input.provenanceComplete;
  const identityComplete = input.noGoldCount === 0 &&
    input.evaluatorIdentityIssueCount === 0 &&
    input.evaluatorIdentityUnscorableCount === 0;
  const eligible = evidenceComplete && abstentionStatus !== "uncalibrated" &&
    identityComplete;
  return {
    schema_version: "bench-measurement-attribution.v2",
    status: eligible ? "eligible" : "ineligible",
    gate_eligible: eligible,
    evidence_status: evidenceComplete ? "complete" : "partial",
    candidate_pool_complete: input.candidatePoolComplete,
    provenance_complete: input.provenanceComplete,
    abstention_calibration_status: abstentionStatus,
    evaluator_identity_status: identityComplete ? "complete" : "invalid"
  };
}
