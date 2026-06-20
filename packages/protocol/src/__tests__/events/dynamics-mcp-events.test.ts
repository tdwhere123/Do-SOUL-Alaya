import { describe, expect, it } from "vitest";
import {
  DYNAMICS_CONSTANTS} from "../../index.js";




describe("DYNAMICS_CONSTANTS", () => {
  it("is a readonly frozen object", () => {
    expect(Object.isFrozen(DYNAMICS_CONSTANTS)).toBe(true);
  });

  it("has the expected decay profiles", () => {
    expect(DYNAMICS_CONSTANTS.decay_profiles).toEqual({
      pinned: { half_life: Infinity, r_min: 0.8 },
      stable: { half_life: 90 * 24 * 3600 * 1000, r_min: 0.3 },
      normal: { half_life: 30 * 24 * 3600 * 1000, r_min: 0.1 },
      volatile: { half_life: 7 * 24 * 3600 * 1000, r_min: 0.05 },
      hazard: { half_life: 365 * 24 * 3600 * 1000, r_min: 0.5 }
    });
  });

  it("has the expected karma amounts", () => {
    expect(DYNAMICS_CONSTANTS.karma).toEqual({
      accept_gain: 0.15,
      reuse_gain: 0.05,
      evidence_gain: 0.1,
      supersede_penalty: -0.2,
      reject_penalty: -0.3
    });
  });

  it("keeps activation weights normalized to 1.0", () => {
    const total = Object.values(DYNAMICS_CONSTANTS.activation_weights_phase1b).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("keeps manifestation thresholds monotonic", () => {
    const { hidden_max, hint_max, excerpt_max, full_min } = DYNAMICS_CONSTANTS.manifestation_thresholds;
    expect(hidden_max).toBeLessThan(hint_max);
    expect(hint_max).toBeLessThan(excerpt_max);
    expect(excerpt_max).toBeLessThanOrEqual(full_min);
  });
});
