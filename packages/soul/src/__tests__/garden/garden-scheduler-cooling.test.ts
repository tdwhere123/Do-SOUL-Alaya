import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTaskKind,
  GardenTier,
  GardenEventType,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { GardenScheduler, InMemoryGardenTaskRepo } from "../../garden/scheduler.js";

import {
  createResult,
  createScheduler,
  createTask,
  enqueueVisibleTierViolation,
  readCoolingMap
} from "./garden-scheduler-fixtures.js";

describe("GardenScheduler", () => {  it("keeps tier-1 cooling active when the scheduler clock becomes invalid", async () => {
    let now = "2026-03-27T00:00:00.000Z";
    const { scheduler } = createScheduler({
      coolingPeriodMs: 60_000,
      now: () => now
    });

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-green-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        role: GardenRole.AUDITOR,
        tier: GardenTier.TIER_1,
        objects_affected: ["memory-1"]
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-green-2",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        target_object_refs: ["memory-1"]
      })
    );

    now = "not-a-timestamp";
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toBeNull();
    expect(readCoolingMap(scheduler).size).toBe(1);
  });


  it("does not apply cooling to tier-2 work", async () => {
    let now = "2026-03-27T00:00:00.000Z";
    const { scheduler } = createScheduler({
      coolingPeriodMs: 60_000,
      now: () => now
    });

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-merge-1",
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        objects_affected: ["memory-1"]
      })
    );

    scheduler.enqueue(
      createTask({
        task_id: "task-merge-2",
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        required_tier: GardenTier.TIER_2,
        target_object_refs: ["memory-1"]
      })
    );

    now = "2026-03-27T00:00:30.000Z";
    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({
      task_id: "task-merge-2"
    });
  });


  it("prunes expired cooling entries on a later scheduler call", async () => {
    let now = "2026-03-27T00:00:00.000Z";
    const { scheduler } = createScheduler({
      coolingPeriodMs: 60_000,
      now: () => now
    });

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-green-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        role: GardenRole.AUDITOR,
        tier: GardenTier.TIER_1,
        objects_affected: ["memory-1"]
      })
    );
    expect(readCoolingMap(scheduler).size).toBe(1);

    now = "2026-03-27T00:02:00.000Z";
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-0",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0
      })
    );

    await scheduler.dispatchNext(GardenRole.JANITOR);
    expect(readCoolingMap(scheduler).size).toBe(0);
  });


  it("emits completion events and updates queue depth across enqueue and dispatch", async () => {
    const { eventLog, scheduler } = createScheduler();
    scheduler.enqueue(createTask({ task_id: "task-1", priority: 10 }));
    scheduler.enqueue(createTask({ task_id: "task-2", priority: 20 }));
    expect(scheduler.queueDepth).toBe(2);

    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    expect(scheduler.queueDepth).toBe(1);

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-2",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        objects_affected: ["memory-1", "memory-2"]
      })
    );

    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_id: "task-2"
      })
    );
  });


  it("exposes global backlog snapshots and warning transitions without changing queue behavior", async () => {
    const { scheduler } = createScheduler({
      now: () => "2026-04-23T08:00:00.000Z",
      backlogWarningThresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1
      }
    });

    expect(scheduler.getBacklogSnapshot()).toEqual({
      workspace_id: null,
      observed_at: "2026-04-23T08:00:00.000Z",
      queue_depth_total: 0,
      queue_depth_by_tier: {
        tier_0: 0,
        tier_1: 0,
        tier_2: 0
      },
      in_flight_total: 0,
      warning_active: false
    });
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();

    scheduler.enqueue(
      createTask({
        task_id: "task-tier-0",
        required_tier: GardenTier.TIER_0
      })
    );
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();

    scheduler.enqueue(
      createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    expect(scheduler.getBacklogSnapshot()).toMatchObject({
      queue_depth_total: 2,
      queue_depth_by_tier: {
        tier_0: 1,
        tier_1: 1,
        tier_2: 0
      },
      warning_active: true
    });
    const armSignal = scheduler.peekBacklogWarningTransition();
    expect(armSignal).toEqual({
      transition_id: 1,
      transition: "arm",
      snapshot: {
        workspace_id: null,
        observed_at: "2026-04-23T08:00:00.000Z",
        queue_depth_total: 2,
        queue_depth_by_tier: {
          tier_0: 1,
          tier_1: 1,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: true
      }
    });
    expect(scheduler.acknowledgeBacklogWarningTransition(armSignal!.transition_id)).toBe(true);
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();

    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    expect(scheduler.getBacklogSnapshot()).toMatchObject({
      queue_depth_total: 1,
      in_flight_total: 1
    });
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();

    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    const clearSignal = scheduler.peekBacklogWarningTransition();
    expect(clearSignal).toEqual({
      transition_id: 2,
      transition: "clear",
      snapshot: {
        workspace_id: null,
        observed_at: "2026-04-23T08:00:00.000Z",
        queue_depth_total: 0,
        queue_depth_by_tier: {
          tier_0: 0,
          tier_1: 0,
          tier_2: 0
        },
        in_flight_total: 2,
        warning_active: false
      }
    });
    expect(scheduler.acknowledgeBacklogWarningTransition(clearSignal!.transition_id)).toBe(true);
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();
  });


  it("preserves backlog warning transition history until each crossing is acknowledged", async () => {
    const { scheduler } = createScheduler({
      now: () => "2026-04-23T08:00:00.000Z",
      backlogWarningThresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1
      }
    });

    scheduler.enqueue(
      createTask({
        task_id: "task-tier-0",
        required_tier: GardenTier.TIER_0
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    const armSignal = scheduler.peekBacklogWarningTransition();
    expect(armSignal).toEqual(
      expect.objectContaining({
        transition_id: 1,
        transition: "arm"
      })
    );

    await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    await scheduler.dispatchNext(GardenRole.LIBRARIAN);

    expect(scheduler.peekLastBacklogWarningTransitionId()).toBe(2);
    expect(scheduler.acknowledgeBacklogWarningTransition(armSignal!.transition_id)).toBe(true);
    expect(scheduler.peekBacklogWarningTransition()).toEqual(
      expect.objectContaining({
        transition_id: 2,
        transition: "clear"
      })
    );
    expect(scheduler.acknowledgeBacklogWarningTransition(2)).toBe(true);
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();
  });


  it("does not mutate queue or warning state when dispatch append fails", async () => {
    const eventLog = {
      append: vi
        .fn(async () => undefined)
        .mockRejectedValueOnce(new Error("dispatch append failed"))
    };
    const scheduler = new GardenScheduler(eventLog, {
      now: () => "2026-04-23T08:00:00.000Z",
      backlogWarningThresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1
      }
    });

    scheduler.enqueue(
      createTask({
        task_id: "task-a",
        required_tier: GardenTier.TIER_0
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-b",
        required_tier: GardenTier.TIER_0,
        priority: 9
      })
    );

    const armSignal = scheduler.peekBacklogWarningTransition();
    expect(armSignal).toEqual(expect.objectContaining({ transition: "arm" }));
    expect(scheduler.acknowledgeBacklogWarningTransition(armSignal!.transition_id)).toBe(true);

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).rejects.toThrow("dispatch append failed");

    expect(scheduler.queueDepth).toBe(2);
    expect(scheduler.getBacklogSnapshot()).toMatchObject({
      queue_depth_total: 2,
      warning_active: true
    });
    expect(scheduler.peekBacklogWarningTransition()).toBeNull();
  });

  // invariant: rollback restores attempt_count with status/claim fields so
  // repeated failed dispatch appends do not make retries appear older.

  it("restores attempt_count on dispatch-append rollback", async () => {
    const eventLog = {
      append: vi
        .fn(async () => undefined)
        .mockRejectedValueOnce(new Error("first append failed"))
        .mockRejectedValueOnce(new Error("second append failed"))
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(
      eventLog,
      { now: () => "2026-04-23T08:00:00.000Z" },
      null,
      repo
    );

    scheduler.enqueue(
      createTask({ task_id: "task-i3", required_tier: GardenTier.TIER_0 })
    );

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).rejects.toThrow(
      "first append failed"
    );
    expect(repo.findById("task-i3")?.attempt_count).toBe(0);

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).rejects.toThrow(
      "second append failed"
    );
    expect(repo.findById("task-i3")?.attempt_count).toBe(0);

    // Successful retry: attempt_count bumps to exactly 1, not 3.
    const dispatched = await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    expect(dispatched).not.toBeNull();
    expect(repo.findById("task-i3")?.attempt_count).toBe(1);
  });

});
