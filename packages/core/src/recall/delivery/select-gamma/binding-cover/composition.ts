import type { OpenSemanticFactorCompositionReceipt } from
  "../../../field/open-semantic-factors/composition.js";

export type BindingValuesStatus = "observed" | "truncated" | "unavailable";

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
