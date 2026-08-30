import { describe, expect, it } from "vitest";
import {
  createMembershipFrontierWitness,
  frontierInformationLeq,
  isKnownZeroEpistemic,
  meetMembershipFrontier,
  refineMembershipFrontier,
  type MembershipFrontierWitness,
  type WitnessEpistemic
} from "../../../../recall/shadow/witness/index.js";
import { PINS, PROV, PROV_EXTENDED, UNISSUED_COMPLETENESS } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function frontier(
  epistemic: WitnessEpistemic,
  payload: { lower: number; upper: number } | null
): MembershipFrontierWitness {
  return createMembershipFrontierWitness({
    identity: PINS,
    provenance: PROV,
    epistemic,
    payload
  });
}

describe("membership frontier domain", () => {
  const wide = frontier({ kind: "exact" }, { lower: 0, upper: 8 });
  const mid = frontier({ kind: "exact" }, { lower: 1, upper: 4 });
  const tight = frontier({ kind: "exact" }, { lower: 2, upper: 2 });
  const other = frontier({ kind: "exact" }, { lower: 9, upper: 10 });
  const outside = frontier({ kind: "not_applicable" }, null);
  const missing = frontier({ kind: "not_observed" }, null);

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([wide, mid, tight, other, outside, missing], frontierInformationLeq);
  });

  it("refines by narrowing a nonnegative index range", () => {
    assertMonotoneRefinement(wide, mid, frontierInformationLeq, refineMembershipFrontier);
    expect(refineMembershipFrontier(wide, {
      ...tight,
      provenance: PROV_EXTENDED
    }).payload).toEqual({ lower: 2, upper: 2 });
  });

  it("does not treat disjoint ranges as known non-membership", () => {
    const met = meetMembershipFrontier(tight, other);
    expect(met.epistemic.kind).toBe("conflict");
    expect(isKnownZeroEpistemic(met.epistemic)).toBe(false);
    expect(met.payload).toBeNull();
  });

  it("requires completeness for known non-membership and marks outside as not_applicable", () => {
    expect(() => frontier({ kind: "exact" }, null)).toThrow(/index range/u);
    expect(() => frontier(
      { kind: "exact", known_zero: true, completeness: {
        ...UNISSUED_COMPLETENESS, domain: "membership_frontier"
      } }, null
    )).toThrow(/issued completeness authority/u);
    expect(outside.epistemic.kind).toBe("not_applicable");
    expect(() => frontier({ kind: "exact" }, { lower: -1, upper: 2 })).toThrow(/nonnegative/u);
    expect(() => frontier({ kind: "exact" }, { lower: 1.5, upper: 2 })).toThrow(/integer/u);
  });
});
