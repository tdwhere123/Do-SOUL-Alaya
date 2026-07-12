import type { RefinementCtx } from "zod";

interface MeasurementDenominatorPayload {
  readonly evaluated_count: number;
  readonly answerable_evaluated_count?: number;
  readonly measurement_attribution?: {
    readonly schema_version:
      | "bench-measurement-attribution.v1"
      | "bench-measurement-attribution.v2";
    readonly status: "eligible" | "ineligible";
    readonly gate_eligible: boolean;
    readonly evidence_status: "complete" | "partial";
    readonly candidate_pool_complete: boolean;
    readonly provenance_complete: boolean;
    readonly abstention_calibration_status: "not_applicable" | "uncalibrated";
    readonly evaluator_identity_status?: "complete" | "invalid";
  };
  readonly kpi: {
    readonly r_at_5: number;
    readonly per_scenario: readonly {
      readonly hit_at_5: boolean;
      readonly scorable?: boolean;
    }[];
    readonly quality_metrics?: {
      readonly no_gold_count: number;
      readonly evaluator_identity_issue_count?: number;
      readonly evaluator_identity_unscorable_count?: number;
      readonly measurement_cohort_counts?: {
        readonly evaluated: number;
        readonly non_abstention: number;
        readonly abstention: number;
        readonly scorable_answerable: number;
        readonly unscorable_answerable: number;
        readonly hit_at_5: number;
        readonly miss_at_5: number;
      };
      readonly abstention?: {
        readonly schema_version: "bench-abstention.v1" | "bench-abstention.v2";
        readonly total: number;
      };
    };
  };
}

export function validateMeasurementDenominatorContract(
  payload: MeasurementDenominatorPayload,
  context: RefinementCtx
): void {
  validateAbstentionAttribution(payload, context);
  validateMeasurementCohortAgreement(payload, context);
  const attribution = payload.measurement_attribution;
  const claimsEligibility = attribution?.schema_version ===
    "bench-measurement-attribution.v2" &&
    (attribution.status === "eligible" || attribution.gate_eligible === true);
  const identityComplete = hasCompleteEvaluatorIdentity(payload);
  addIssue(
    context,
    !claimsEligibility || identityComplete,
    "eligible measurement attribution requires zero evaluator identity issues",
    ["kpi", "quality_metrics"]
  );
  addIssue(
    context,
    !claimsEligibility || measurementContractAllowsEligibility(payload),
    "current eligible measurement attribution requires complete denominator, scorable rows, evaluator identity, and v2 abstention evidence",
    ["measurement_attribution"]
  );
  const answerable = payload.answerable_evaluated_count;
  if (answerable === undefined) return;
  const rows = payload.kpi.per_scenario;
  addIssue(context, rows.length === payload.evaluated_count,
    "per_scenario length must equal evaluated_count");
  addIssue(context, rows.every((row) => row.scorable !== undefined),
    "answerable_evaluated_count requires explicit scorable rows");
  const scorable = rows.filter((row) => row.scorable === true).length;
  addIssue(context, scorable === answerable,
    "answerable_evaluated_count must match scorable=true rows");
  const hits = rows.filter((row) => row.scorable === true && row.hit_at_5).length;
  const expectedRAt5 = answerable === 0 ? 0 : hits / answerable;
  addIssue(context, payload.kpi.r_at_5 === expectedRAt5,
    "r_at_5 must equal scorable hit_at_5 rows divided by answerable_evaluated_count",
    ["kpi", "r_at_5"]);
  const abstentionTotal = payload.kpi.quality_metrics?.abstention?.total ?? 0;
  const identityUnscorable =
    payload.kpi.quality_metrics?.evaluator_identity_unscorable_count ?? 0;
  addIssue(context, rows.length - scorable === abstentionTotal + identityUnscorable,
    "scorable=false rows must match abstention and evaluator identity unscorable counts");
}

function validateMeasurementCohortAgreement(
  payload: MeasurementDenominatorPayload,
  context: RefinementCtx
): void {
  const counts = payload.kpi.quality_metrics?.measurement_cohort_counts;
  if (counts === undefined) return;
  const rows = payload.kpi.per_scenario;
  addMeasurementCohortIssue(
    context,
    counts.evaluated === payload.evaluated_count,
    "evaluated must match evaluated_count"
  );
  if (payload.answerable_evaluated_count !== undefined) {
    addMeasurementCohortIssue(
      context,
      counts.scorable_answerable === payload.answerable_evaluated_count,
      "scorable answerable must match answerable_evaluated_count"
    );
  }
  addMeasurementCohortIssue(
    context,
    rows.length === counts.evaluated,
    "evaluated must match per-scenario rows"
  );
  if (rows.some((row) => row.scorable === undefined)) {
    addMeasurementCohortIssue(context, false, "per-scenario rows require explicit scorable state");
    return;
  }
  const scorableRows = rows.filter((row) => row.scorable === true);
  const hitCount = scorableRows.filter((row) => row.hit_at_5).length;
  addMeasurementCohortIssue(
    context,
    scorableRows.length === counts.scorable_answerable,
    "scorable answerable must match per-scenario rows"
  );
  addMeasurementCohortIssue(
    context,
    hitCount === counts.hit_at_5,
    "hit_at_5 must match per-scenario rows"
  );
  addMeasurementCohortIssue(
    context,
    scorableRows.length - hitCount === counts.miss_at_5,
    "miss_at_5 must match per-scenario rows"
  );
}

function addMeasurementCohortIssue(
  context: RefinementCtx,
  valid: boolean,
  detail: string
): void {
  addIssue(
    context,
    valid,
    `measurement cohort ${detail}`,
    ["kpi", "quality_metrics", "measurement_cohort_counts"]
  );
}

export function measurementContractAllowsEligibility(
  payload: MeasurementDenominatorPayload
): boolean {
  const attribution = payload.measurement_attribution;
  const answerable = payload.answerable_evaluated_count;
  const rows = payload.kpi.per_scenario;
  const abstention = payload.kpi.quality_metrics?.abstention;
  if (!attribution || answerable === undefined || !abstention) return false;
  const scorable = rows.filter((row) => row.scorable === true).length;
  const attributionEligible = attribution.status === "eligible" &&
    attribution.schema_version === "bench-measurement-attribution.v2" &&
    attribution.gate_eligible &&
    attribution.evidence_status === "complete" &&
    attribution.candidate_pool_complete && attribution.provenance_complete &&
    attribution.abstention_calibration_status === "not_applicable" &&
    attribution.evaluator_identity_status === "complete";
  const abstentionEligible = abstention.schema_version === "bench-abstention.v2" &&
    abstention.total === 0;
  const rowsComplete = rows.length === payload.evaluated_count &&
    rows.every((row) => row.scorable !== undefined);
  const identityUnscorable =
    payload.kpi.quality_metrics?.evaluator_identity_unscorable_count;
  const denominatorMatches = scorable === answerable &&
    identityUnscorable !== undefined &&
    rows.length - scorable === abstention.total + identityUnscorable;
  return attributionEligible && abstentionEligible && rowsComplete &&
    denominatorMatches && hasCompleteEvaluatorIdentity(payload);
}

function hasCompleteEvaluatorIdentity(payload: MeasurementDenominatorPayload): boolean {
  const metrics = payload.kpi.quality_metrics;
  return metrics?.no_gold_count === 0 && metrics.evaluator_identity_issue_count === 0 &&
    metrics.evaluator_identity_unscorable_count === 0;
}

function validateAbstentionAttribution(
  payload: MeasurementDenominatorPayload,
  context: RefinementCtx
): void {
  const abstention = payload.kpi.quality_metrics?.abstention;
  const attribution = payload.measurement_attribution;
  if (!attribution) return;
  if (!abstention) return;
  if (abstention.schema_version === "bench-abstention.v2" && abstention.total === 0) return;
  const valid = attribution.abstention_calibration_status === "uncalibrated" &&
    attribution.status === "ineligible" && !attribution.gate_eligible;
  if (valid) return;
  context.addIssue({
    code: "custom",
    path: ["measurement_attribution"],
    message: "legacy or nonzero abstention evidence must remain uncalibrated and ineligible"
  });
}

function addIssue(
  context: RefinementCtx,
  valid: boolean,
  message: string,
  path: readonly (string | number)[] = ["kpi", "per_scenario"]
): void {
  if (valid) return;
  context.addIssue({ code: "custom", path: [...path], message });
}
