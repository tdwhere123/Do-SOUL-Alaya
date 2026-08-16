import type {
  SelectGammaEligibilityInput
} from "./types.js";

export function gateSelectGammaEligibility(
  inputs: readonly SelectGammaEligibilityInput[]
): readonly string[] {
  return Object.freeze(inputs.flatMap((input) =>
    input.risk === "clear" && input.authority === "clear"
      ? [input.candidate_key]
      : []
  ));
}
