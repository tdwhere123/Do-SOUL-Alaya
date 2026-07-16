import {
  KpiPayloadSchema,
  isCacheOnlySeedExtractionPath,
  longMemEvalSelectionContractAllowsEligibility,
  type KpiPayload
} from "@do-soul/alaya-eval";

export interface CurrentKpiEvidence {
  readonly payload: KpiPayload | null;
  readonly issue: string | null;
}

export function parseCurrentKpiEvidence(value: unknown): CurrentKpiEvidence {
  const parsed = KpiPayloadSchema.safeParse(value);
  if (parsed.success) return { payload: parsed.data, issue: null };
  return {
    payload: null,
    issue: parsed.error.issues.map((issue) =>
      `${issue.path.join(".")}: ${issue.message}`
    ).join("; ")
  };
}

export function assertCurrentComparisonEvidence(
  evidence: CurrentKpiEvidence,
  label: "control" | "treatment"
): void {
  const payload = evidence.payload;
  if (payload === null) {
    throw new Error(
      `${label} attributed comparison requires a current valid KPI payload: ` +
      (evidence.issue ?? "unknown schema error")
    );
  }
  if (payload.recall_eval_attribution?.gate_eligible !== true) {
    throw new Error(`${label} attributed comparison requires eligible recall attribution`);
  }
  if (payload.measurement_attribution?.gate_eligible !== true) {
    throw new Error(`${label} attributed comparison requires eligible measurement attribution`);
  }
  if (!longMemEvalSelectionContractAllowsEligibility(payload)) {
    throw new Error(`${label} attributed comparison requires bound selection evidence`);
  }
  if (!isCacheOnlySeedExtractionPath(payload.kpi.seed_extraction_path)) {
    throw new Error(`${label} attributed comparison requires cache-only seed extraction`);
  }
}
