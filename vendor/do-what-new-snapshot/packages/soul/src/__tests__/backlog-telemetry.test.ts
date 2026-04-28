import { describe, expect, it } from "vitest";
import { evaluateBacklogPressure } from "../garden/backlog-telemetry.js";

const thresholds = {
  warning_queue_depth: 10,
  warning_rearm_depth: 7
} as const;

describe("evaluateBacklogPressure", () => {
  it("arms when the queue depth crosses above the warning threshold", () => {
    expect(
      evaluateBacklogPressure({
        armed: false,
        queueDepthTotal: 11,
        thresholds
      })
    ).toBe("arm");
  });

  it("clears when an armed queue drops below the rearm threshold", () => {
    expect(
      evaluateBacklogPressure({
        armed: true,
        queueDepthTotal: 6,
        thresholds
      })
    ).toBe("clear");
  });

  it("does not re-arm when the queue remains stably over threshold", () => {
    expect(
      evaluateBacklogPressure({
        armed: true,
        queueDepthTotal: 15,
        thresholds
      })
    ).toBe("none");
  });

  it("does not emit a transition when the warning state is unchanged", () => {
    expect(
      evaluateBacklogPressure({
        armed: false,
        queueDepthTotal: 7,
        thresholds
      })
    ).toBe("none");
  });
});
