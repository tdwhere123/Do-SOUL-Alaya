import { describe, expect, it } from "vitest";
import {
  normalizeCompileSeedSourceTime,
  requireLongMemEvalTimestamp
} from "../../../longmemeval/ingestion/source-time.js";

describe("normalizeCompileSeedSourceTime", () => {
  it("normalizes dataset source dates without host timezone dependence", () => {
    expect(normalizeCompileSeedSourceTime("2023/04/01 (Sat) 19:22")).toBe(
      "2023-04-01T19:22:00.000Z"
    );
    expect(normalizeCompileSeedSourceTime("2025-12-01")).toBe(
      "2025-12-01T00:00:00.000Z"
    );
    expect(normalizeCompileSeedSourceTime("2025-12-01T08:09:10.000Z")).toBe(
      "2025-12-01T08:09:10.000Z"
    );
  });

  it("rejects rollover and unsupported source dates", () => {
    expect(normalizeCompileSeedSourceTime("2026-02-31")).toBeUndefined();
    expect(normalizeCompileSeedSourceTime("not-a-date")).toBeUndefined();
    expect(() => requireLongMemEvalTimestamp("not-a-date")).toThrow(/invalid LongMemEval timestamp/u);
    expect(() => requireLongMemEvalTimestamp(undefined)).toThrow(/invalid LongMemEval timestamp/u);
  });
});
