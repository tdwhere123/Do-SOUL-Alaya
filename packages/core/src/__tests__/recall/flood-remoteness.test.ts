import { describe, expect, it } from "vitest";

import { evaluateSingleHopRemoteness } from "../../recall/flood/remoteness.js";

describe("single-hop flood remoteness", () => {
  it.each([
    [0, 0.8, "missing_or_zero_input"],
    [0.8, 0, "non_positive_conductance"]
  ] as const)("rejects zero input or conductance", (inputPotential, edgeConductance, reason) => {
    expect(evaluateSingleHopRemoteness({
      inputPotential, edgeConductance, capPerSource: 1, selfLoop: false
    })).toEqual({
      rawTransfer: inputPotential * edgeConductance,
      cappedTransfer: 0,
      sliceCompatibility: "not_evaluated",
      decision: "rejected",
      reason
    });
  });

  it("treats no query key as neutral even when enforcement is enabled", () => {
    const result = evaluateSingleHopRemoteness({
      inputPotential: 0.8,
      edgeConductance: 0.5,
      capPerSource: 1,
      selfLoop: false,
      enforceSliceCompatibility: true,
      sliceCompatibility: { decision: "pass_through", reason: "no_query_key", matches: [] }
    });

    expect(result).toEqual({
      rawTransfer: 0.4,
      cappedTransfer: 0.4,
      sliceCompatibility: "no_query_key",
      decision: "transferred",
      reason: "transferred"
    });
  });

  it.each([
    "missing_source_key",
    "missing_target_key",
    "missing_source_and_target_key"
  ] as const)("transfers through incomplete projection reason %s", (reason) => {
    const result = evaluateSingleHopRemoteness({
      inputPotential: 0.8,
      edgeConductance: 0.5,
      capPerSource: 1,
      selfLoop: false,
      enforceSliceCompatibility: true,
      sliceCompatibility: { decision: "pass_through", reason, matches: [] }
    });

    expect(result).toMatchObject({
      cappedTransfer: 0.4,
      sliceCompatibility: reason,
      decision: "transferred",
      reason: "transferred"
    });
  });

  it("preserves legacy arithmetic while slice enforcement is disabled", () => {
    const result = evaluateSingleHopRemoteness({
      inputPotential: 0.8,
      edgeConductance: 2,
      capPerSource: 0.3,
      selfLoop: false
    });

    expect(result.rawTransfer).toBe(1.6);
    expect(result.cappedTransfer).toBe(0.3);
    expect(result.reason).toBe("capped");
  });

  it.each([0, -0.25])("rejects a non-positive per-source cap", (capPerSource) => {
    expect(evaluateSingleHopRemoteness({
      inputPotential: 0.8,
      edgeConductance: 0.5,
      capPerSource,
      selfLoop: false
    })).toEqual({
      rawTransfer: 0.4,
      cappedTransfer: 0,
      sliceCompatibility: "not_evaluated",
      decision: "rejected",
      reason: "capped"
    });
  });

  it("rejects a positive transfer that underflows to zero", () => {
    expect(evaluateSingleHopRemoteness({
      inputPotential: Number.MIN_VALUE,
      edgeConductance: Number.MIN_VALUE,
      capPerSource: 1,
      selfLoop: false
    })).toMatchObject({
      rawTransfer: 0,
      cappedTransfer: 0,
      decision: "rejected",
      reason: "missing_or_zero_input"
    });
  });

  it("bounds experimental transfer inputs when slice enforcement is enabled", () => {
    const result = evaluateSingleHopRemoteness({
      inputPotential: 2,
      edgeConductance: 2,
      capPerSource: 4,
      selfLoop: false,
      enforceSliceCompatibility: true
    });

    expect(result.rawTransfer).toBe(1);
    expect(result.cappedTransfer).toBe(1);
  });

  it("is monotone until the configured per-source bound", () => {
    const transfer = (inputPotential: number) => evaluateSingleHopRemoteness({
      inputPotential, edgeConductance: 0.8, capPerSource: 0.5, selfLoop: false
    }).cappedTransfer;

    expect(transfer(0.2)).toBeLessThanOrEqual(transfer(0.4));
    expect(transfer(0.4)).toBeLessThanOrEqual(transfer(1));
    expect(transfer(1)).toBeLessThanOrEqual(0.5);
  });

  it("observes a mismatch by default and rejects it only when explicitly enforced", () => {
    const base = {
      inputPotential: 0.8,
      edgeConductance: 0.5,
      capPerSource: 1,
      selfLoop: false,
      sliceCompatibility: { decision: "rejected", reason: "no_slice_match", matches: [] }
    } as const;

    expect(evaluateSingleHopRemoteness(base).decision).toBe("transferred");
    expect(evaluateSingleHopRemoteness({ ...base, enforceSliceCompatibility: true })).toEqual({
      rawTransfer: 0.4,
      cappedTransfer: 0,
      sliceCompatibility: "no_slice_match",
      decision: "rejected",
      reason: "no_slice_match"
    });
  });

  it("normalizes non-finite and out-of-range experimental inputs", () => {
    expect(evaluateSingleHopRemoteness({
      inputPotential: Number.POSITIVE_INFINITY,
      edgeConductance: 2,
      capPerSource: 4,
      selfLoop: false,
      enforceSliceCompatibility: true
    })).toMatchObject({
      rawTransfer: 0,
      cappedTransfer: 0,
      decision: "rejected",
      reason: "missing_or_zero_input"
    });

    expect(evaluateSingleHopRemoteness({
      inputPotential: 2,
      edgeConductance: 2,
      capPerSource: 4,
      selfLoop: false,
      enforceSliceCompatibility: true
    })).toMatchObject({
      rawTransfer: 1,
      cappedTransfer: 1,
      decision: "transferred"
    });
  });
});
