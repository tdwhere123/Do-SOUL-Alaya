import { describe, expect, it } from "vitest";
import {
  addDuration,
  ensureIsoDatetime,
  isExpired,
  readClockSnapshot,
  readNow,
  systemNow
} from "../../shared/time.js";

describe("shared time helpers", () => {
  it("normalizes ISO datetimes and rejects invalid values", () => {
    expect(ensureIsoDatetime("2026-04-20T08:00:00.000Z", "now")).toBe("2026-04-20T08:00:00.000Z");
    expect(() => ensureIsoDatetime("not-a-timestamp", "now")).toThrow(
      "now must return a valid ISO timestamp"
    );
  });

  it("adds duration to ISO datetimes", () => {
    expect(addDuration("2026-04-20T08:00:00.000Z", 90_000)).toBe("2026-04-20T08:01:30.000Z");
    expect(() => addDuration("not-a-timestamp", 1)).toThrow("now must return a valid ISO timestamp");
  });

  it("reads normalized now values through the shared fallback helper", () => {
    expect(readNow(() => "2026-04-20T08:00:00Z")).toBe("2026-04-20T08:00:00.000Z");
    expect(systemNow()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("captures an ISO + epoch clock snapshot", () => {
    expect(readClockSnapshot(() => "2026-04-20T08:00:00Z")).toEqual({
      iso: "2026-04-20T08:00:00.000Z",
      epochMs: Date.parse("2026-04-20T08:00:00.000Z")
    });
  });

  it("compares expiry against a reference timestamp", () => {
    expect(isExpired(null, "2026-04-20T08:00:00.000Z")).toBe(false);
    expect(isExpired("2026-04-20T07:59:59.999Z", "2026-04-20T08:00:00.000Z")).toBe(true);
    expect(isExpired("2026-04-20T08:00:00.000Z", "2026-04-20T08:00:00.000Z")).toBe(true);
    expect(isExpired("2026-04-20T08:00:01.000Z", "2026-04-20T08:00:00.000Z")).toBe(false);
  });

  it("treats corrupt expiry as expired and rejects invalid reference clocks", () => {
    expect(isExpired("not-a-timestamp", "2026-04-20T08:00:00.000Z")).toBe(true);
    expect(() => isExpired("2026-04-20T08:00:00.000Z", "not-a-timestamp")).toThrow(
      "referenceTime must be a valid ISO timestamp"
    );
  });
});
