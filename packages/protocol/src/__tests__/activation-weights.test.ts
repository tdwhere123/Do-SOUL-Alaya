import { describe, expect, it } from "vitest";
import { DYNAMICS_CONSTANTS } from "../soul/dynamics-constants.js";

describe("activation_weights_phase4b", () => {
  const weights = DYNAMICS_CONSTANTS.activation_weights_phase4b;

  it("has all 8 required weight keys", () => {
    expect(weights).toHaveProperty("scope_match");
    expect(weights).toHaveProperty("domain_match");
    expect(weights).toHaveProperty("retention");
    expect(weights).toHaveProperty("freshness");
    expect(weights).toHaveProperty("relevance");
    expect(weights).toHaveProperty("graph_support");
    expect(weights).toHaveProperty("budget_penalty");
    expect(weights).toHaveProperty("conflict_penalty");
  });

  it("all 8 weights sum to exactly 1.0", () => {
    const sum =
      weights.scope_match +
      weights.domain_match +
      weights.retention +
      weights.freshness +
      weights.relevance +
      weights.graph_support +
      weights.budget_penalty +
      weights.conflict_penalty;

    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("all weights are positive", () => {
    for (const value of Object.values(weights)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("base 4-factor weights sum to 0.70", () => {
    const base =
      weights.scope_match +
      weights.domain_match +
      weights.retention +
      weights.freshness;

    expect(Math.abs(base - 0.7)).toBeLessThan(1e-9);
  });

  it("keeps phase1b weights unchanged", () => {
    expect(DYNAMICS_CONSTANTS.activation_weights_phase1b.scope_match).toBeCloseTo(0.27);
    expect(DYNAMICS_CONSTANTS.activation_weights_phase1b.domain_match).toBeCloseTo(0.27);
    expect(DYNAMICS_CONSTANTS.activation_weights_phase1b.retention).toBeCloseTo(0.27);
    expect(DYNAMICS_CONSTANTS.activation_weights_phase1b.freshness).toBeCloseTo(0.19);
  });

  it("reduces phase4b scope_match relative to phase1b", () => {
    expect(weights.scope_match).toBeLessThan(DYNAMICS_CONSTANTS.activation_weights_phase1b.scope_match);
  });
});