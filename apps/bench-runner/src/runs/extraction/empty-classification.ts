import {
  catalogEligibilityOfAssertionCount,
  OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM,
  type OfficialApiCatalogEligibility,
  type classifyOfficialApiRequestResult
} from "@do-soul/alaya-soul";

export type ExtractionRequestCompletion = ReturnType<typeof classifyOfficialApiRequestResult>["status"];
export type ExtractionCatalogEligibility = OfficialApiCatalogEligibility;
export const EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST =
  OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM;
export { catalogEligibilityOfAssertionCount };
export const EXTRACTION_REQUEST_COMPLETION_VERSION = 1;
export interface PersistedExtractionRequestCompletion {
  readonly version: typeof EXTRACTION_REQUEST_COMPLETION_VERSION;
  readonly status: ExtractionRequestCompletion;
}

export const EXTRACTION_EMPTY_CLASSIFICATIONS = [
  "completed_signals",
  "completed_empty",
  "unclassified_empty",
  "provider_empty_with_assertions",
  "deterministic_empty",
  "plan_skipped"
] as const;

export type ExtractionEmptyClassification =
  (typeof EXTRACTION_EMPTY_CLASSIFICATIONS)[number];

export const EMPTY_SIGNALS_ENVELOPE = '{"signals":[]}' as const;
export const PLAN_SKIPPED_EXTRACTION_ENVELOPE =
  '{"extraction_skip":"plan_skipped"}' as const;

/** Request-processing classification. It does not claim source semantic exhaustion. */
export function classifyExtractionEnvelope(input: {
  readonly rawSignalCount: number;
  /** Eligible catalog assertions in this request window, not source information. */
  readonly sourceAssertionCount: number;
  readonly planMembership: "in_plan" | "skipped";
  readonly requestCompletion?: ExtractionRequestCompletion;
}): ExtractionEmptyClassification {
  if (input.planMembership === "skipped") return "plan_skipped";
  if (input.requestCompletion !== undefined) return input.requestCompletion;
  if (input.rawSignalCount > 0) return "completed_signals";
  return input.sourceAssertionCount > 0
    ? "provider_empty_with_assertions"
    : "deterministic_empty";
}

export function extractionEnvelopeCountsTowardCoverage(
  classification: ExtractionEmptyClassification
): boolean {
  return classification === "completed_signals" ||
    classification === "completed_empty" ||
    classification === "deterministic_empty";
}

export function isPlanSkippedExtraction(value: {
  readonly extractionSkip?: string;
}): boolean {
  return value.extractionSkip === "plan_skipped";
}
