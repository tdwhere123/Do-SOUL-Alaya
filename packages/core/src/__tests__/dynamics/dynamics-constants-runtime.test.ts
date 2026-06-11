import { describe, expect, it } from "vitest";
import {
  DIMENSION_DEFAULT_DECAY_PROFILE,
  computeDecayedRetention,
  computeFreshnessFactor,
  determineManifestation
} from "../../dynamics/dynamics-constants-runtime.js";

describe("dynamics constants runtime", () => {
  it("maps dimensions to expected default decay profiles", () => {
    expect(DIMENSION_DEFAULT_DECAY_PROFILE.hazard).toBe("hazard");
    expect(DIMENSION_DEFAULT_DECAY_PROFILE.glossary).toBe("pinned");
    expect(DIMENSION_DEFAULT_DECAY_PROFILE.episode).toBe("volatile");
  });

  it("keeps pinned retention at max(r_min, confidence + karma)", () => {
    const retention = computeDecayedRetention({
      initialConfidence: 0.7,
      karmaSumAmount: -0.05,
      halfLifeMs: Infinity,
      rMin: 0.8,
      elapsedMs: 999999999
    });

    expect(retention).toBe(0.8);
  });

  it("returns confidence + karma when elapsed time is zero", () => {
    const retention = computeDecayedRetention({
      initialConfidence: 0.6,
      karmaSumAmount: 0.1,
      halfLifeMs: 1000,
      rMin: 0.1,
      elapsedMs: 0
    });

    expect(retention).toBeCloseTo(0.7, 10);
  });

  it("halves base retention at one half-life", () => {
    const retention = computeDecayedRetention({
      initialConfidence: 0.6,
      karmaSumAmount: 0.1,
      halfLifeMs: 1000,
      rMin: 0.1,
      elapsedMs: 1000
    });

    expect(retention).toBeCloseTo(0.4, 10);
  });

  it("derives manifestation states and thresholds", () => {
    expect(determineManifestation(0.05)).toBe("hidden");
    expect(determineManifestation(0.15)).toBe("hint");
    expect(determineManifestation(0.45)).toBe("excerpt");
    expect(determineManifestation(0.75)).toBe("full_eligible");
    expect(determineManifestation(0.1)).toBe("hint");
    expect(determineManifestation(0.3)).toBe("excerpt");
  });

  it("computes freshness from created_at when last_used_at is null", () => {
    const freshness = computeFreshnessFactor({
      lastUsedAt: null,
      createdAt: "2026-03-23T00:00:00.000Z",
      now: "2026-03-23T00:00:00.000Z"
    });

    expect(freshness).toBe(1);
  });

  it("drops freshness to zero after 30 days", () => {
    const freshness = computeFreshnessFactor({
      lastUsedAt: "2026-02-21T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      now: "2026-03-23T00:00:00.000Z"
    });

    expect(freshness).toBe(0);
  });
});
