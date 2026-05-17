import { describe, expect, it } from "vitest";
import {
  ciAwareBand,
  deriveSampleSizeLabel,
  wilsonHalfWidthPp,
  wilsonInterval
} from "../wilson-ci.js";

describe("wilsonInterval", () => {
  it("returns zero interval for total = 0", () => {
    const interval = wilsonInterval(0, 0);
    expect(interval).toEqual({ lo: 0, hi: 0, center: 0 });
  });

  it("brackets the observed proportion at 95% confidence", () => {
    const interval = wilsonInterval(72, 100);
    expect(interval.lo).toBeLessThan(0.72);
    expect(interval.hi).toBeGreaterThan(0.72);
    const halfWidthPp = ((interval.hi - interval.lo) / 2) * 100;
    expect(halfWidthPp).toBeGreaterThan(8);
    expect(halfWidthPp).toBeLessThan(10);
  });

  it("does not extend below 0 or above 1 even at the extremes", () => {
    const zeroes = wilsonInterval(0, 30);
    expect(zeroes.lo).toBe(0);
    expect(zeroes.hi).toBeLessThan(0.2);
    const ones = wilsonInterval(30, 30);
    expect(ones.hi).toBe(1);
    expect(ones.lo).toBeGreaterThan(0.8);
  });

  it("half-width shrinks as sample size grows", () => {
    const smallN = wilsonHalfWidthPp(15, 30);
    const largeN = wilsonHalfWidthPp(250, 500);
    expect(largeN).toBeLessThan(smallN);
  });
});

describe("ciAwareBand", () => {
  it("returns raw band when sample is large enough", () => {
    const raw = { warn: 2, fail: 5 };
    const widened = ciAwareBand(raw, 72, 100);
    expect(widened).toEqual(raw);
  });

  it("widens band to at least the CI half-width on small samples", () => {
    const raw = { warn: 2, fail: 5 };
    const widened = ciAwareBand(raw, 15, 30);
    const halfWidthPp = wilsonHalfWidthPp(15, 30);
    expect(widened.warn).toBeGreaterThanOrEqual(halfWidthPp);
    expect(widened.fail).toBeGreaterThanOrEqual(halfWidthPp);
    expect(widened.warn).toBeGreaterThan(raw.warn);
    expect(widened.fail).toBeGreaterThan(raw.fail);
  });
});

describe("deriveSampleSizeLabel", () => {
  it("labels worst_shard_bound latency as shard_merged regardless of evaluated count", () => {
    expect(deriveSampleSizeLabel(500, "worst_shard_bound")).toBe("shard_merged");
    expect(deriveSampleSizeLabel(50, "worst_shard_bound")).toBe("shard_merged");
    expect(deriveSampleSizeLabel(5, "worst_shard_bound")).toBe("shard_merged");
  });

  it("returns smoke when evaluated_count is at or below 50", () => {
    expect(deriveSampleSizeLabel(1, "exact")).toBe("smoke");
    expect(deriveSampleSizeLabel(50, "exact")).toBe("smoke");
  });

  it("returns staged when evaluated_count is in 51-200", () => {
    expect(deriveSampleSizeLabel(51, "exact")).toBe("staged");
    expect(deriveSampleSizeLabel(100, "exact")).toBe("staged");
    expect(deriveSampleSizeLabel(200, "exact")).toBe("staged");
  });

  it("returns shard_merged when evaluated_count is in 201-499", () => {
    expect(deriveSampleSizeLabel(201, "exact")).toBe("shard_merged");
    expect(deriveSampleSizeLabel(300, "exact")).toBe("shard_merged");
    expect(deriveSampleSizeLabel(499, "exact")).toBe("shard_merged");
  });

  it("returns full when evaluated_count is at or above 500", () => {
    expect(deriveSampleSizeLabel(500, "exact")).toBe("full");
    expect(deriveSampleSizeLabel(1986, "exact")).toBe("full");
  });
});
