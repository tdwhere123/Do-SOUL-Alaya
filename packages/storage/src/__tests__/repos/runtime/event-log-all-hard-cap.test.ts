import { describe, expect, it } from "vitest";
import {
  enforceEventLogAllHardCap,
  EVENT_LOG_ALL_QUERY_HARD_MAX
} from "../../../repos/runtime/event-log-rows.js";

describe("enforceEventLogAllHardCap", () => {
  it("accepts histories at or below the hard cap", () => {
    const rows = Array.from({ length: EVENT_LOG_ALL_QUERY_HARD_MAX }, (_, index) => index);
    expect(enforceEventLogAllHardCap(rows, "run", "run-1")).toHaveLength(
      EVENT_LOG_ALL_QUERY_HARD_MAX
    );
  });

  it("rejects histories above the hard cap", () => {
    const rows = Array.from({ length: EVENT_LOG_ALL_QUERY_HARD_MAX + 1 }, (_, index) => index);
    expect(() => enforceEventLogAllHardCap(rows, "run", "run-1")).toThrowError(
      /exceeds the hard cap/
    );
  });
});
