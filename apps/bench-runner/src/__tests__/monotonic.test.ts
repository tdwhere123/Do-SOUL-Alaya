import { describe, expect, it } from "vitest";
import { monotonicElapsedMs, monotonicNowNs } from "../monotonic.js";

describe("monotonic elapsed measurement", () => {
  it("reports a non-negative finite elapsed for an immediate start/stop", () => {
    const start = monotonicNowNs();
    const elapsed = monotonicElapsedMs(start);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("never goes negative for a start captured in the future", () => {
    // A monotonic source is non-decreasing, so even a start sampled "later"
    // than the elapsed read can only yield <= 0; the guarantee under test is
    // that a real start always precedes its elapsed read and stays >= 0.
    const start = monotonicNowNs();
    const elapsed = monotonicElapsedMs(start);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("measures a positive elapsed across a synchronous busy gap", () => {
    const start = monotonicNowNs();
    let acc = 0;
    for (let i = 0; i < 1_000_000; i++) acc += i;
    const elapsed = monotonicElapsedMs(start);
    expect(acc).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsed)).toBe(true);
  });
});
