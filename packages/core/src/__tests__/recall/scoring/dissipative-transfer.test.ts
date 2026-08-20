import { describe, expect, it } from "vitest";
import {
  assertDissipativeLambda,
  assertDissipativeRho,
  computeDissipativeMessage,
  scaleOutgoingTransfers
} from "../../../recall/scoring/activation/dissipative-transfer.js";

describe("dissipative transfer", () => {
  it("rejects lambda and rho outside the open unit interval", () => {
    expect(() => assertDissipativeLambda(1)).toThrow(/lambda/u);
    expect(() => assertDissipativeLambda(-0.01)).toThrow(/lambda/u);
    expect(() => assertDissipativeRho(1)).toThrow(/rho/u);
    expect(assertDissipativeLambda(0)).toBe(0);
    expect(assertDissipativeRho(0.99)).toBe(0.99);
  });

  it("computes max(0, lambda * activation - hop_cost)", () => {
    expect(computeDissipativeMessage({
      lambda: 0.5,
      activation: 1,
      hop_cost: 0.1
    })).toBeCloseTo(0.4);
    expect(computeDissipativeMessage({
      lambda: 0.2,
      activation: 0.3,
      hop_cost: 0.1
    })).toBe(0);
  });

  it("caps outgoing transferable energy by rho_c * available", () => {
    const scaled = scaleOutgoingTransfers([0.4, 0.4], 1, 0.5);
    expect(scaled[0]! + scaled[1]!).toBeCloseTo(0.5);
    expect(scaleOutgoingTransfers([0.2, 0.2], 1, 0.5)).toEqual([0.2, 0.2]);
  });

  it("strictly dissipates energy along a hop chain", () => {
    let energy = 1;
    for (let hop = 0; hop < 8 && energy > 0; hop += 1) {
      const next = computeDissipativeMessage({
        lambda: 0.6,
        activation: energy,
        hop_cost: 0.05
      });
      expect(next).toBeLessThan(energy);
      energy = next;
    }
    expect(energy).toBe(0);
  });
});
