import type { ProductPhaseLedger } from
  "../../../../diagnostics/phase/phase-authority.js";

export function notObservedPhaseLedger(): ProductPhaseLedger {
  return {
    formation: { phase: "formation", status: null, authority: "not_observed" },
    composition: { phase: "composition", status: null, authority: "not_observed" },
    activation: { phase: "activation", status: null, authority: "not_observed" },
    selection: { phase: "selection", status: null, authority: "not_observed" },
    delivery: { phase: "delivery", status: null, authority: "not_observed" }
  };
}
