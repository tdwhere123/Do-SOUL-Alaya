import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTaskKind,
  GardenTier} from "@do-soul/alaya-protocol";
import { GardenScheduler, InMemoryGardenTaskRepo } from "../../garden/scheduler.js";

import {
  createTask,
  enqueueVisibleTierViolation} from "./garden-scheduler-fixtures.js";

describe("GardenScheduler", () => {  it("does not remove a tier-violation task when the reject append fails", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(
      eventLog,
      {
        now: () => "2026-04-23T08:00:00.000Z",
        backlogWarningThresholds: {
          warning_queue_depth: 1,
          warning_rearm_depth: 1
        }
      },
      null,
      repo
    );

    enqueueVisibleTierViolation(repo, {
      task_id: "task-invalid",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1,
      priority: 50
    });
    scheduler.enqueue(
      createTask({
        task_id: "task-valid",
        required_tier: GardenTier.TIER_0,
        priority: 40
      })
    );

    const armSignal = scheduler.peekBacklogWarningTransition();
    expect(armSignal).toEqual(expect.objectContaining({ transition: "arm" }));
    expect(scheduler.acknowledgeBacklogWarningTransition(armSignal!.transition_id)).toBe(true);

    eventLog.append.mockRejectedValueOnce(new Error("tier violation append failed"));

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).rejects.toThrow(
      "tier violation append failed"
    );

    expect(scheduler.queueDepth).toBe(2);
    expect(scheduler.getBacklogSnapshot()).toMatchObject({
      queue_depth_total: 2,
      warning_active: true
    });
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();
    expect(scheduler.queueDepth).toBe(1);
    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toMatchObject({
      task_id: "task-valid"
    });
  });


  it("reuses cached descriptors after enqueue in the in-memory fallback queue", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(eventLog, {}, null, repo);

    scheduler.enqueue(createTask({ task_id: "task-a" }));
    scheduler.enqueue(createTask({ task_id: "task-b" }));

    const parseSpy = vi.spyOn(GardenTaskDescriptorSchema, "parse");

    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    await scheduler.dispatchNext(GardenRole.LIBRARIAN);

    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });
});
