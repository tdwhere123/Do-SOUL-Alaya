import { describe, expect, it } from "vitest";
import {
  buildPerPlaneRecallCoverage,
  isDeliveredScoreOrderNonMonotonic
} from "../../../diagnostics/quality/diagnostics-quality-helpers.js";

describe("buildPerPlaneRecallCoverage", () => {
  it("keeps exact binary rates unrounded and drops hit-only planes", () => {
    const coverage = buildPerPlaneRecallCoverage(
      new Map([["lexical", 2]]),
      new Map([["lexical", 1], ["ghost", 9]])
    );
    expect(coverage).toEqual({
      lexical: { gold_count: 2, hit_at_5_count: 1, hit_at_5_rate: 0.5 }
    });
    expect(coverage).not.toHaveProperty("ghost");
  });

  it("uses an unrounded repeating ratio and missing hits as zero, not absence", () => {
    const coverage = buildPerPlaneRecallCoverage(
      new Map([["lexical", 3], ["alpha", 1], ["beta", 3]]),
      new Map([["lexical", 1], ["beta", 2]])
    );
    expect(coverage.lexical).toEqual({
      gold_count: 3,
      hit_at_5_count: 1,
      hit_at_5_rate: 1 / 3
    });
    expect(coverage.beta).toEqual({
      gold_count: 3,
      hit_at_5_count: 2,
      hit_at_5_rate: 2 / 3
    });
    expect(coverage.lexical?.hit_at_5_rate).not.toBe(0.333333);
    expect(coverage.beta?.hit_at_5_rate).not.toBe(0.666667);
    expect(coverage.alpha).toEqual({
      gold_count: 1,
      hit_at_5_count: 0,
      hit_at_5_rate: 0
    });
  });

  it("emits a zero gold plane as a measured zero rate", () => {
    expect(
      buildPerPlaneRecallCoverage(new Map([["lexical", 0]]), new Map())
    ).toEqual({
      lexical: { gold_count: 0, hit_at_5_count: 0, hit_at_5_rate: 0 }
    });
    expect(buildPerPlaneRecallCoverage(new Map(), new Map())).toEqual({});
  });

  it("orders plane keys by localeCompare regardless of Map insertion", () => {
    const coverage = buildPerPlaneRecallCoverage(
      new Map([["zeta", 1], ["alpha", 2], ["mu", 1]]),
      new Map([["alpha", 1]])
    );
    expect(Object.keys(coverage)).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("isDeliveredScoreOrderNonMonotonic", () => {
  it.each([
    { name: "empty", scores: [], expected: false },
    { name: "single", scores: [0.4], expected: false },
    { name: "equal", scores: [0.5, 0.5, 0.5], expected: false },
    { name: "increasing", scores: [0.2, 0.8], expected: true },
    { name: "decreasing", scores: [0.8, 0.2], expected: false },
    { name: "equal then increase", scores: [0.4, 0.4, 0.5], expected: true },
    { name: "decrease then increase", scores: [0.9, 0.1, 0.2], expected: true }
  ])("classifies $name score arrays", ({ scores, expected }) => {
    expect(isDeliveredScoreOrderNonMonotonic(scores)).toBe(expected);
  });
});
