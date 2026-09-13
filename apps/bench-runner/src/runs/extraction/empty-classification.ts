export const EXTRACTION_EMPTY_CLASSIFICATIONS = [
  "completed_signals",
  "provider_empty_with_assertions",
  "deterministic_empty",
  "plan_skipped"
] as const;

export type ExtractionEmptyClassification =
  (typeof EXTRACTION_EMPTY_CLASSIFICATIONS)[number];

export const EMPTY_SIGNALS_ENVELOPE = '{"signals":[]}' as const;
export const PLAN_SKIPPED_EXTRACTION_ENVELOPE = EMPTY_SIGNALS_ENVELOPE;

export function classifyExtractionEnvelope(input: {
  readonly rawSignalCount: number;
  readonly sourceAssertionCount: number;
  readonly planMembership: "in_plan" | "skipped";
}): ExtractionEmptyClassification {
  if (input.planMembership === "skipped") return "plan_skipped";
  if (input.rawSignalCount > 0) return "completed_signals";
  return input.sourceAssertionCount > 0
    ? "provider_empty_with_assertions"
    : "deterministic_empty";
}

export function extractionEnvelopeCountsTowardCoverage(
  classification: ExtractionEmptyClassification
): boolean {
  return classification === "completed_signals" ||
    classification === "deterministic_empty";
}

export function isPlanSkippedExtraction(value: {
  readonly extractionSkip?: string;
}): boolean {
  return value.extractionSkip === "plan_skipped";
}
