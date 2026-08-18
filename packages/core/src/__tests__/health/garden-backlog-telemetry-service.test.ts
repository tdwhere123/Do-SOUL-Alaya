import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputeRecallGardenEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { GardenBacklogTelemetryService } from
  "../../health/garden-backlog-telemetry-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("GardenBacklogTelemetryService snapshot publish", () => {
  it("retries a failed snapshot append once on the next tick", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let appendCalls = 0;
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        appendCalls += 1;
        if (appendCalls === 1) {
          throw new Error("append failed");
        }
        return {
          event_id: `event-${appendCalls}`,
          created_at: "2026-08-18T00:00:00.000Z",
          revision: appendCalls,
          ...entry
        };
      }),
      queryByEntity: vi.fn(async () => [])
    };
    const service = new GardenBacklogTelemetryService({
      scheduler: {
        getBacklogSnapshot: () => ({
          workspace_id: null,
          observed_at: "2026-08-18T00:00:00.000Z",
          queue_depth_total: 0,
          queue_depth_by_tier: { tier_0: 0, tier_1: 0, tier_2: 0 },
          in_flight_total: 0,
          warning_active: false
        }),
        peekBacklogWarningTransition: () => null,
        peekLastBacklogWarningTransitionId: () => null,
        acknowledgeBacklogWarningTransition: () => false
      },
      eventLogRepo,
      warn,
      thresholds: {
        warning_queue_depth: 10,
        warning_rearm_depth: 7,
        snapshot_interval_ms: 1_000
      }
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "garden backlog snapshot publish failed",
      expect.objectContaining({ error: "append failed" })
    );
    expect(eventLogRepo.append).toHaveBeenCalledTimes(2);
    expect(eventLogRepo.append.mock.calls[1]?.[0]).toMatchObject({
      event_type: ComputeRecallGardenEventType.GARDEN_BACKLOG_TELEMETRY_SNAPSHOT
    });

    await service.stop();
  });
});
