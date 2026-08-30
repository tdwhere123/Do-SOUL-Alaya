import { describe, expect, it } from "vitest";
import {
  consumerView,
  createNumericIntervalWitness,
  isKnownZeroEpistemic,
  parseCompleteness,
  serializeWitness,
  type NumericIntervalWitness,
  type WitnessEpistemic
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PINS, PROV, UNISSUED_COMPLETENESS } from "./fixtures.js";

function numeric(
  epistemic: WitnessEpistemic,
  payload: { lower: number; upper: number } | null
): NumericIntervalWitness {
  return createNumericIntervalWitness({
    identity: PINS,
    provenance: PROV,
    epistemic,
    payload
  });
}

describe("epistemic carrier remains distinct from payload", () => {
  const exactZero = numeric({ kind: "exact" }, { lower: 0, upper: 0 });
  const unavailable = numeric({ kind: "unavailable" }, null);
  const notObserved = numeric({ kind: "not_observed" }, null);
  const notApplicable = numeric({ kind: "not_applicable" }, null);
  const negative = numeric({ kind: "negative", named_negative: "h_hidden" }, null);
  const conflict = numeric({ kind: "conflict" }, null);

  const states = {
    exact_zero: exactZero,
    unavailable,
    not_observed: notObserved,
    not_applicable: notApplicable,
    negative,
    conflict
  };

  it("keeps exact zero ≠ unavailable ≠ not-observed ≠ not-applicable ≠ negative ≠ conflict", () => {
    const serialized = Object.entries(states).map(([name, witness]) => [
      name,
      serializeWitness(witness),
      JSON.stringify(witness),
      JSON.stringify(consumerView(witness))
    ]);
    for (let index = 0; index < serialized.length; index += 1) {
      for (let other = index + 1; other < serialized.length; other += 1) {
        const left = serialized[index]!;
        const right = serialized[other]!;
        expect(left[1], `${left[0]} serialize`).not.toBe(right[1]);
        expect(left[2], `${left[0]} json`).not.toBe(right[2]);
        expect(left[3], `${left[0]} view`).not.toBe(right[3]);
        expect(states[left[0] as keyof typeof states]).not.toEqual(
          states[right[0] as keyof typeof states]
        );
      }
    }
  });

  it("never encodes unknown or not-applicable as numeric 0 or false", () => {
    for (const witness of [unavailable, notObserved, notApplicable, negative, conflict]) {
      expect(witness.payload).toBeNull();
      expect(serializeWitness(witness)).not.toMatch(/payload:\{lower:0,upper:0\}/u);
      expect(JSON.stringify(consumerView(witness))).not.toMatch(/"epistemic":0/u);
      expect(JSON.stringify(consumerView(witness))).not.toMatch(/"epistemic":false/u);
    }
    expect(exactZero.payload).toEqual({ lower: 0, upper: 0 });
    expect(isKnownZeroEpistemic(exactZero.epistemic)).toBe(false);
  });

  it("rejects strings, owner-only objects, and coherent scoped receipts", () => {
    expect(() => parseCompleteness("arbitrary.owner"))
      .toThrow(/issued|authority|completeness/u);
    expect(() => numeric({
      kind: "exact",
      known_zero: true,
      completeness: { owner: "arbitrary.owner" } as typeof UNISSUED_COMPLETENESS
    }, { lower: 0, upper: 0 })).toThrow(/issued|authority|completeness/u);

    for (const completeness of [
      UNISSUED_COMPLETENESS,
      { ...UNISSUED_COMPLETENESS },
      { ...UNISSUED_COMPLETENESS, snapshot_digest: `sha256:${"e".repeat(64)}` },
      { ...UNISSUED_COMPLETENESS, universe_digest: `sha256:${"f".repeat(64)}` },
      { ...UNISSUED_COMPLETENESS, coordinate_id: "coord.foreign" },
      { ...UNISSUED_COMPLETENESS, domain: "membership_frontier" as const }
    ]) {
      expect(() => numeric({
        kind: "exact", known_zero: true, completeness
      }, { lower: 0, upper: 0 })).toThrow(/issued|authority|completeness/u);
    }
  });
});
