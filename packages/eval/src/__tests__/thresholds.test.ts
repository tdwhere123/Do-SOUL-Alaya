import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  classifyHotShareDrop,
  classifyLatencyGrowth,
  classifyRatioDrop,
  rollupWorstVerdict
} from "../thresholds.js";

describe("classifyRatioDrop", () => {
  it("returns ok when the drop is below the warn threshold", () => {
    const result = classifyRatioDrop(0.94, 0.95, DEFAULT_THRESHOLDS.r_at_5_drop_pp);
    expect(result.verdict).toBe("ok");
    expect(result.deltaPp).toBeCloseTo(1, 5);
  });

  it("escalates to warn when the drop crosses the warn threshold", () => {
    const result = classifyRatioDrop(0.92, 0.95, DEFAULT_THRESHOLDS.r_at_5_drop_pp);
    expect(result.verdict).toBe("warn");
  });

  it("escalates to fail when the drop exceeds the fail threshold", () => {
    const result = classifyRatioDrop(0.89, 0.95, DEFAULT_THRESHOLDS.r_at_5_drop_pp);
    expect(result.verdict).toBe("fail");
  });

  it("treats improvements as ok with a negative deltaPp", () => {
    const result = classifyRatioDrop(0.97, 0.95, DEFAULT_THRESHOLDS.r_at_5_drop_pp);
    expect(result.verdict).toBe("ok");
    expect(result.deltaPp).toBeLessThan(0);
  });
});

describe("classifyLatencyGrowth", () => {
  it("returns ok when previous is zero (avoids divide-by-zero)", () => {
    const result = classifyLatencyGrowth(
      120,
      0,
      DEFAULT_THRESHOLDS.latency_p95_growth_ratio
    );
    expect(result.verdict).toBe("ok");
  });

  it("returns warn at +25% latency growth", () => {
    const result = classifyLatencyGrowth(
      125,
      100,
      DEFAULT_THRESHOLDS.latency_p95_growth_ratio
    );
    expect(result.verdict).toBe("warn");
  });

  it("returns fail at +60% latency growth", () => {
    const result = classifyLatencyGrowth(
      160,
      100,
      DEFAULT_THRESHOLDS.latency_p95_growth_ratio
    );
    expect(result.verdict).toBe("fail");
  });
});

describe("classifyHotShareDrop", () => {
  it("compares hot share ratio across distributions", () => {
    const result = classifyHotShareDrop(
      { hot: 60, warm: 30, cold: 10 },
      { hot: 80, warm: 15, cold: 5 },
      DEFAULT_THRESHOLDS.hot_share_drop_pp
    );
    expect(result.verdict).toBe("fail");
  });

  it("returns ok when distributions are empty", () => {
    const result = classifyHotShareDrop(
      { hot: 0, warm: 0, cold: 0 },
      { hot: 0, warm: 0, cold: 0 },
      DEFAULT_THRESHOLDS.hot_share_drop_pp
    );
    expect(result.verdict).toBe("ok");
  });
});

describe("rollupWorstVerdict", () => {
  it("returns fail when any input is fail", () => {
    expect(rollupWorstVerdict(["ok", "warn", "fail"])).toBe("fail");
  });

  it("returns warn when none are fail but some are warn", () => {
    expect(rollupWorstVerdict(["ok", "warn", "ok"])).toBe("warn");
  });

  it("returns ok when all are ok", () => {
    expect(rollupWorstVerdict(["ok", "ok", "ok"])).toBe("ok");
  });
});
