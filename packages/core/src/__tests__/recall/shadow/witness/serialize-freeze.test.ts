import { describe, expect, it } from "vitest";
import {
  createBindingRelationWitness,
  createCorrelationWitness,
  createFourValuedWitness,
  createMustMayWitness,
  createNumericIntervalWitness,
  digestWitness,
  serializeWitness
} from "../../../../recall/shadow/witness/index.js";
import { PAIR_PINS, PINS, PROPOSITION_PINS, PROV } from "./fixtures.js";

const numeric = createNumericIntervalWitness({
  identity: PINS,
  provenance: PROV,
  epistemic: { kind: "exact" },
  payload: { lower: 1, upper: 3 }
});

const witnesses = [
  numeric,
  createMustMayWitness({
    identity: PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { must: ["b", "a"], may: ["c", "b", "a"] }
  }),
  createBindingRelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { left_id: "l", right_id: "r", state: "may_equal" }
  }),
  createFourValuedWitness({
    identity: PROPOSITION_PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { polarity: "supported_only" }
  }),
  createCorrelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { left_id: "a", right_id: "b", state: "possibly_correlated" }
  })
];

describe("witness serialization and immutability", () => {
  it("serializes deterministically and freezes outputs", () => {
    for (const witness of witnesses) {
      expect(serializeWitness(witness)).toBe(serializeWitness(witness));
      expect(digestWitness(witness)).toBe(digestWitness(witness));
      expect(Object.isFrozen(witness)).toBe(true);
      expect(Object.isFrozen(witness.identity)).toBe(true);
      expect(Object.isFrozen(witness.provenance)).toBe(true);
      expect(Object.isFrozen(witness.epistemic)).toBe(true);
      if (witness.payload !== null) expect(Object.isFrozen(witness.payload)).toBe(true);
      expect(() => {
        (witness as { domain: string }).domain = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        (witness.provenance as WitnessProvenanceEntry[]).push({
          source_id: "x",
          producer: "y"
        });
      }).toThrow(TypeError);
    }
  });

  it("normalizes must/may members without depending on insertion order", () => {
    const left = createMustMayWitness({
      identity: PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { must: ["b", "a"], may: ["c", "a", "b"] }
    });
    const right = createMustMayWitness({
      identity: PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { must: ["a", "b"], may: ["a", "b", "c"] }
    });
    expect(serializeWitness(left)).toBe(serializeWitness(right));
    expect(left.payload?.must).toEqual(["a", "b"]);
  });

  it("canonicalizes must/may members by exact code units", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(composed === decomposed).toBe(false);

    const forward = createMustMayWitness({
      identity: PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { must: [composed, decomposed], may: [composed, decomposed] }
    });
    const reverse = createMustMayWitness({
      identity: PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { must: [decomposed, composed], may: [decomposed, composed] }
    });

    expect(forward.payload?.must).toEqual(reverse.payload?.must);
    expect(forward.payload?.may).toEqual(reverse.payload?.may);
    expect(serializeWitness(forward)).toBe(serializeWitness(reverse));
    expect(digestWitness(forward)).toBe(digestWitness(reverse));
    expect(forward.payload?.must).toEqual([decomposed, composed]);
    expect(forward.payload?.may).toEqual([decomposed, composed]);
  });
});

type WitnessProvenanceEntry = { source_id: string; producer: string };
