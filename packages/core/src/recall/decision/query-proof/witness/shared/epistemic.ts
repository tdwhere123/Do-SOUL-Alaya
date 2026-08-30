import {
  freezeShadow,
  requireNonemptyString,
  ShadowContractError
} from "../../../prefix-capture/envelope.js";
import { parseCompleteness } from "./completeness.js";
import type {
  WitnessCompleteness,
  WitnessEpistemic
} from "./types.js";

export function isKnownZeroEpistemic(
  epistemic: WitnessEpistemic
): epistemic is Extract<WitnessEpistemic, { readonly known_zero: true }> {
  return epistemic.kind === "exact" && "known_zero" in epistemic;
}

export function isUnknownEpistemic(epistemic: WitnessEpistemic): boolean {
  return epistemic.kind === "unavailable" || epistemic.kind === "not_observed";
}

export function parseEpistemic(input: WitnessEpistemic): WitnessEpistemic {
  if (input.kind === "exact") return parseExactEpistemic(input);
  if (input.kind === "negative") return parseNegativeEpistemic(input);
  if (
    input.kind === "unavailable" ||
    input.kind === "not_observed" ||
    input.kind === "not_applicable" ||
    input.kind === "conflict"
  ) {
    return freezeShadow({ kind: input.kind });
  }
  throw new ShadowContractError("unknown epistemic kind");
}

export function freezeEpistemic(epistemic: WitnessEpistemic): WitnessEpistemic {
  return parseEpistemic(epistemic);
}

export function exactEpistemic(): WitnessEpistemic {
  return freezeShadow({ kind: "exact" as const });
}

export function conflictEpistemic(): WitnessEpistemic {
  return freezeShadow({ kind: "conflict" as const });
}

export function completenessOwner(epistemic: WitnessEpistemic): string | null {
  return isKnownZeroEpistemic(epistemic) ? epistemic.completeness.owner : null;
}

export { parseCompleteness };

function parseExactEpistemic(input: WitnessEpistemic): WitnessEpistemic {
  if (!("known_zero" in input)) return freezeShadow({ kind: "exact" as const });
  if (input.known_zero !== true) {
    throw new ShadowContractError("known_zero must be exact with completeness");
  }
  return freezeShadow({
    kind: "exact" as const,
    known_zero: true as const,
    completeness: parseCompleteness(input.completeness)
  });
}

function parseNegativeEpistemic(input: WitnessEpistemic): WitnessEpistemic {
  if (input.kind !== "negative") {
    throw new ShadowContractError("negative epistemic requires a named consumer");
  }
  return freezeShadow({
    kind: "negative" as const,
    named_negative: requireNonemptyString(input.named_negative, "named_negative")
  });
}
