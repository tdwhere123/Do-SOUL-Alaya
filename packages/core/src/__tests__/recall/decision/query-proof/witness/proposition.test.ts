import { describe, expect, it } from "vitest";
import {
  createFourValuedWitness,
  fourValuedInformationLeq,
  meetFourValued,
  refineFourValued,
  type FourValuedPolarity,
  type FourValuedWitness
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PROPOSITION_PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function proposition(polarity: FourValuedPolarity): FourValuedWitness {
  const epistemic = polarity === "both"
    ? { kind: "conflict" as const }
    : { kind: "exact" as const };
  return createFourValuedWitness({
    identity: PROPOSITION_PINS,
    provenance: PROV,
    epistemic,
    payload: { polarity }
  });
}

describe("four-valued proposition domain", () => {
  const unknown = proposition("unknown");
  const supported = proposition("supported_only");
  const refuted = proposition("refuted_only");
  const both = proposition("both");

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([unknown, supported, refuted, both], fourValuedInformationLeq);
  });

  it("lets unknown refine to a concrete polarity", () => {
    assertMonotoneRefinement(
      unknown,
      supported,
      fourValuedInformationLeq,
      refineFourValued
    );
    expect(refineFourValued(unknown, {
      ...refuted,
      provenance: PROV_EXTENDED
    }).payload?.polarity).toBe("refuted_only");
  });

  it("meets supported and refuted as both/conflict, never last-write-wins", () => {
    const met = meetFourValued(supported, refuted);
    expect(met.epistemic.kind).toBe("conflict");
    expect(met.payload?.polarity).toBe("both");
    expect(refineFourValued(supported, refuted).payload?.polarity).toBe("both");
    expect(refineFourValued(supported, both).payload?.polarity).toBe("both");
  });

  it("keeps both absorbing so conflict cannot refine away", () => {
    expect(() => refineFourValued(both, supported)).toThrow(/widening/u);
    expect(fourValuedInformationLeq(both, supported)).toBe(false);
    expect(meetFourValued(both, unknown).epistemic.kind).toBe("conflict");
  });
});
