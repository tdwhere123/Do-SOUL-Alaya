import { describe, expect, it } from "vitest";
import { ShadowContractError } from "../../../../../recall/decision/query-proof/envelope.js";
import {
  bitemporalInformationLeq,
  createBitemporalWitness,
  meetBitemporal,
  refineBitemporal,
  type BitemporalPayload,
  type BitemporalWitness,
  type TransactionTimeForm,
  type ValidTimeForm
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function temporal(
  valid: ValidTimeForm,
  transaction: TransactionTimeForm = { kind: "unknown" }
): BitemporalWitness {
  return createBitemporalWitness({
    identity: PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { valid, transaction }
  });
}

describe("temporal / bitemporal domain", () => {
  const unknown = temporal({ kind: "unknown" });
  const open = temporal({ kind: "open", from: 10 });
  const bounded = temporal({ kind: "bounded", from: 10, to: 40 });
  const tighter = temporal({ kind: "bounded", from: 20, to: 30 });
  const disjoint = temporal({ kind: "bounded", from: 80, to: 90 });
  const timeless = temporal({ kind: "timeless" });
  const txPinned = temporal(
    { kind: "bounded", from: 10, to: 40 },
    { kind: "bounded", from: 100, to: 200 }
  );

  it("has a reflexive antisymmetric transitive information order on comparable forms", () => {
    assertPoset([unknown, open, bounded, tighter, disjoint, txPinned], bitemporalInformationLeq);
    assertPoset([unknown, timeless], bitemporalInformationLeq);
  });

  it("narrows bounded and open valid time and records provenance", () => {
    assertMonotoneRefinement(open, bounded, bitemporalInformationLeq, refineBitemporal);
    const refined = refineBitemporal(bounded, { ...tighter, provenance: PROV_EXTENDED });
    expect((refined.payload as BitemporalPayload).valid).toEqual({
      kind: "bounded",
      from: 20,
      to: 30
    });
  });

  it("rejects widening, inverted bounds, and invented extrema", () => {
    expect(() => refineBitemporal(tighter, bounded)).toThrow(/widening/u);
    expect(() => temporal({ kind: "bounded", from: 40, to: 10 })).toThrow(/inverted/u);
    expect(() => temporal({ kind: "bounded", from: 0, to: Number.POSITIVE_INFINITY }))
      .toThrow(/finite/u);
    expect(() => temporal({ kind: "open", from: Number.NaN })).toThrow(/finite/u);
  });

  it("rejects illegal timeless vs interval comparison", () => {
    expect(() => bitemporalInformationLeq(timeless, bounded)).toThrow(
      /illegal temporal-domain comparison/u
    );
    expect(() => meetBitemporal(timeless, bounded)).toThrow(
      /illegal temporal-domain comparison/u
    );
    expect(() => refineBitemporal(timeless, bounded)).toThrow(
      /illegal temporal-domain comparison/u
    );
  });

  it("keeps transaction time as a separate coordinate", () => {
    expect(bitemporalInformationLeq(bounded, txPinned)).toBe(true);
    expect(bitemporalInformationLeq(txPinned, bounded)).toBe(false);
    expect(meetBitemporal(bounded, disjoint).epistemic.kind).toBe("conflict");
  });
});
