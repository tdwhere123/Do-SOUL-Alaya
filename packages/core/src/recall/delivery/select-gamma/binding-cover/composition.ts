import type { OpenSemanticFactorCompositionReceipt } from
  "../../../field/open-semantic-factors/composition.js";
import type { CoverAvailability } from "../types.js";

export type BindingValuesStatus = "observed" | "truncated" | "unavailable";
export type CoverEvidence = "available" | "unavailable";
export type { CoverAvailability };

export function usableOpenSemanticFactorComposition(
  composition: Readonly<OpenSemanticFactorCompositionReceipt> | undefined
): composition is Readonly<OpenSemanticFactorCompositionReceipt> {
  return composition !== undefined && composition.status === "composed";
}

export function bindingValuesStatus(
  composition: Readonly<OpenSemanticFactorCompositionReceipt> | undefined
): BindingValuesStatus {
  if (!usableOpenSemanticFactorComposition(composition)) return "unavailable";
  return composition.truncated ? "truncated" : "observed";
}

export function coverEvidenceIsAvailable(
  valuesStatus: BindingValuesStatus,
  obligationFacetCount: number
): boolean {
  return valuesStatus !== "unavailable" || obligationFacetCount > 0;
}

export function resolveCoverEvidence(
  valuesStatus: BindingValuesStatus,
  obligationFacetCount: number
): CoverEvidence {
  return coverEvidenceIsAvailable(valuesStatus, obligationFacetCount)
    ? "available"
    : "unavailable";
}

export function resolveCoverAvailability(params: Readonly<{
  readonly valuesStatus: BindingValuesStatus;
  readonly obligationFacetCount: number;
  readonly coverGain: number;
}>): CoverAvailability {
  if (!coverEvidenceIsAvailable(params.valuesStatus, params.obligationFacetCount)) {
    return "unavailable";
  }
  return params.coverGain > 0 ? "positive" : "known_zero";
}
