import { describe, expect, it } from "vitest";
import {
  createMustMayWitness,
  meetMustMay,
  mustMayInformationLeq,
  refineMustMay,
  type MustMayPayload,
  type MustMayWitness,
  type WitnessEpistemic
} from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function set(
  payload: MustMayPayload | null,
  epistemic: WitnessEpistemic = { kind: "exact" },
  provenance: typeof PROV = PROV
): MustMayWitness {
  return createMustMayWitness({ identity: PINS, provenance, epistemic, payload });
}

describe("finite must/may set domain", () => {
  const wide = set({ must: ["a"], may: ["a", "b", "c"] });
  const mid = set({ must: ["a", "b"], may: ["a", "b", "c"] });
  const tight = set({ must: ["a", "b"], may: ["a", "b"] });
  const other = set({ must: ["z"], may: ["z"] });
  const missing = set(null, { kind: "not_observed" });

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([wide, mid, tight, other, missing], mustMayInformationLeq);
  });

  it("refines by growing must and shrinking may", () => {
    assertMonotoneRefinement(wide, mid, mustMayInformationLeq, refineMustMay);
    const refined = refineMustMay(wide, { ...tight, provenance: PROV_EXTENDED });
    expect(refined.payload).toEqual({ must: ["a", "b"], may: ["a", "b"] });
  });

  it("meets by must-union and may-intersection, conflicting when must escapes may", () => {
    expect(meetMustMay(wide, tight).payload).toEqual({ must: ["a", "b"], may: ["a", "b"] });
    expect(meetMustMay(tight, other).epistemic.kind).toBe("conflict");
  });

  it("rejects dropped must members, grown may, and inverted inclusion", () => {
    expect(() => refineMustMay(tight, wide)).toThrow(/widening|incomparable/u);
    expect(() => refineMustMay(mid, wide)).toThrow(/widening|incomparable/u);
    expect(() => set({ must: ["a", "b"], may: ["a"] })).toThrow(/subset/u);
  });
});
