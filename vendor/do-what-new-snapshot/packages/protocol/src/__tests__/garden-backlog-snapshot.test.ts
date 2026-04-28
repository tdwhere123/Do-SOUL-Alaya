import { describe, expect, it } from "vitest";
import {
  GardenBacklogSnapshotSchema,
  GardenBacklogThresholdsSchema
} from "../index.js";

const observedAt = "2026-04-23T08:00:00.000Z";

describe("Garden backlog read models", () => {
  it("parses the global backlog snapshot schema", () => {
    const snapshot = {
      workspace_id: null,
      observed_at: observedAt,
      queue_depth_total: 12,
      queue_depth_by_tier: {
        tier_0: 3,
        tier_1: 4,
        tier_2: 5
      },
      in_flight_total: 0,
      warning_active: true
    } as const;

    expect(GardenBacklogSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("parses backlog telemetry thresholds", () => {
    const thresholds = {
      warning_queue_depth: 10,
      warning_rearm_depth: 7,
      snapshot_interval_ms: 60_000
    } as const;

    expect(GardenBacklogThresholdsSchema.parse(thresholds)).toEqual(thresholds);
  });

  it("rejects workspace-scoped backlog snapshots for the global queue", () => {
    expect(
      GardenBacklogSnapshotSchema.safeParse({
        workspace_id: "workspace-1",
        observed_at: observedAt,
        queue_depth_total: 1,
        queue_depth_by_tier: {
          tier_0: 1,
          tier_1: 0,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: false
      }).success
    ).toBe(false);
  });
});
