import { describe, expect, it } from "vitest";
import { ShadowContractError } from "../../../../../recall/decision/query-proof/envelope.js";
import {
  compareNumericInterval,
  createNumericIntervalWitness,
  isKnownZeroEpistemic,
  joinNumericInterval,
  meetNumericInterval,
  numericInformationLeq,
  refineNumericInterval,
  serializeWitness,
  type NumericIntervalWitness,
  type WitnessEpistemic
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PINS, PROV, PROV_EXTENDED, UNISSUED_COMPLETENESS, pins } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function numeric(
  epistemic: WitnessEpistemic,
  payload: { lower: number; upper: number } | null,
  extras: { provenance?: typeof PROV; identity?: typeof PINS } = {}
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: extras.identity ?? PINS,
    provenance: extras.provenance ?? PROV,
    epistemic,
    payload
  });
}

const EXACT = { kind: "exact" as const };

describe("numeric interval domain", () => {
  const observed = numeric(EXACT, { lower: 0, upper: 10 });
  const mid = numeric(EXACT, { lower: 2, upper: 5 });
  const tight = numeric(EXACT, { lower: 3, upper: 4 });
  const zero = numeric(EXACT, { lower: 0, upper: 0 });
  const other = numeric(EXACT, { lower: 20, upper: 21 });
  const missing = numeric({ kind: "not_observed" }, null);
  const unavailable = numeric({ kind: "unavailable" }, null);
  const notApplicable = numeric({ kind: "not_applicable" }, null);
  const negative = numeric({ kind: "negative", named_negative: "h_event" }, null);
  const conflict = numeric({ kind: "conflict" }, null);

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([
      observed, mid, tight, zero, other, missing, unavailable,
      notApplicable, negative, conflict
    ], numericInformationLeq);
  });

  it("refines by narrowing and is monotone", () => {
    assertMonotoneRefinement(observed, mid, numericInformationLeq, refineNumericInterval);
    const refined = refineNumericInterval(observed, {
      ...tight,
      provenance: PROV_EXTENDED
    });
    expect(numericInformationLeq(observed, refined)).toBe(true);
    expect(refined.payload).toEqual({ lower: 3, upper: 4 });
  });

  it("meets by intersection and joins by convex hull", () => {
    expect(meetNumericInterval(observed, mid).payload).toEqual({ lower: 2, upper: 5 });
    expect(joinNumericInterval(mid, other).payload).toEqual({ lower: 2, upper: 21 });
    expect(compareNumericInterval(mid, joinNumericInterval(mid, other))).toBe("narrower");
  });

  it("turns disjoint same-identity exact values into conflict, not last-write-wins", () => {
    const result = refineNumericInterval(zero, other);
    expect(result.epistemic.kind).toBe("conflict");
    expect(result.payload).toBeNull();
    expect(meetNumericInterval(zero, other).epistemic.kind).toBe("conflict");
    expect(isKnownZeroEpistemic(result.epistemic)).toBe(false);
  });

  it("rejects widening, pin changes, provenance loss, and invalid bounds", () => {
    expect(() => refineNumericInterval(mid, observed)).toThrow(/widening/u);
    expect(() => refineNumericInterval(mid, numeric(EXACT, { lower: 2, upper: 5 }, {
      identity: pins({ query_id: "query-other" })
    }))).toThrow(/identity pin/u);
    expect(() => refineNumericInterval(
      numeric(EXACT, { lower: 2, upper: 5 }, { provenance: PROV_EXTENDED }),
      mid
    )).toThrow(/provenance/u);
    expect(() => refineNumericInterval(mid, numeric(EXACT, { lower: 2, upper: 5 }, {
      provenance: [{ source_id: "src-1", producer: "producer.replaced" }]
    }))).toThrow(/replacement/u);
    expect(() => numeric(EXACT, { lower: 5, upper: 1 })).toThrow(ShadowContractError);
    expect(() => numeric(EXACT, { lower: Number.NaN, upper: 1 })).toThrow(/finite/u);
    expect(() => numeric(EXACT, { lower: 0, upper: Number.POSITIVE_INFINITY })).toThrow(/finite/u);
  });

  it("does not treat empty intersection as known_zero", () => {
    const met = meetNumericInterval(zero, other);
    expect(met.epistemic.kind).toBe("conflict");
    expect(serializeWitness(met)).not.toContain("known_zero");
  });

  it("keeps exact zero distinct from unknown and rejects unissued known_zero", () => {
    expect(numericInformationLeq(unavailable, zero)).toBe(true);
    expect(numericInformationLeq(zero, unavailable)).toBe(false);
    expect(() => numeric({
      kind: "exact", known_zero: true, completeness: UNISSUED_COMPLETENESS
    }, { lower: 0, upper: 0 })).toThrow(/issued completeness authority/u);
  });

  it("does not join unknown into a fabricated number", () => {
    expect(() => joinNumericInterval(unavailable, mid)).toThrow(/fabricate/u);
    expect(() => joinNumericInterval(notApplicable, mid)).toThrow(/fabricate/u);
    expect(() => joinNumericInterval(conflict, mid)).toThrow(/fabricate/u);
  });
});
