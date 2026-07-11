import { describe, expect, it, vi } from "vitest";

import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";

import { createEventLogOrphanDetectionRunner } from "../../garden/scheduler-runtime-maintenance.js";

function createTask(): GardenTaskDescriptor {
  return {
    task_id: "orphan-task-1",
    task_kind: GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION,
    required_tier: GardenTier.TIER_1,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-07-11T00:00:00.000Z"
  };
}

describe("createEventLogOrphanDetectionRunner", () => {
  it("warns and continues when an iteration throws", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const runAuditorTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("auditor blew up"))
      .mockResolvedValue(undefined);
    let dispatchCalls = 0;
    const runtimeGardenScheduler = {
      dispatchNextMatchingTaskKind: vi.fn(async () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          return createTask();
        }
        return null;
      })
    };

    const runner = createEventLogOrphanDetectionRunner({
      enqueueForAllWorkspaces: vi.fn(async () => {}),
      requestBacklogTelemetryCapture: vi.fn(),
      runAuditorTask,
      runtimeGardenScheduler,
      warn
    });

    const runPromise = runner.runEventLogOrphanDetection();
    await vi.runAllTimersAsync();
    await runPromise;

    expect(warn).toHaveBeenCalledWith(
      "event log orphan detection iteration failed; continuing after backoff",
      expect.objectContaining({
        error: "auditor blew up",
        backoff_ms: 250
      })
    );
    expect(runAuditorTask).toHaveBeenCalledTimes(1);
    expect(runtimeGardenScheduler.dispatchNextMatchingTaskKind).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
