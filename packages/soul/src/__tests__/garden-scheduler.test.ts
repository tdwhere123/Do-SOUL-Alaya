import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  GardenEventType,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { GardenScheduler } from "../garden/scheduler.js";

describe("GardenScheduler", () => {
  it("dispatches a tier-0 task for janitor and emits a dispatch event", async () => {
    const { eventLog, scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-janitor",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0
      })
    );

    const task = await scheduler.dispatchNext(GardenRole.JANITOR);

    expect(task?.task_id).toBe("task-janitor");
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_id: "task-janitor"
      })
    );
  });

  it("returns null for an empty queue", async () => {
    const { eventLog, scheduler } = createScheduler();

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();
    expect(eventLog.append).not.toHaveBeenCalled();
  });

  it("rejects tier violations, records health journal diagnostics, and removes the task", async () => {
    const { eventLog, healthJournal, scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();

    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
        entity_id: "task-tier-1"
      })
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: "garden_backlog",
        workspace_id: "workspace-1"
      })
    );
    expect(scheduler.queueDepth).toBe(0);
  });

  it("uses the injected warn port when tier violation health journal diagnostics fail", async () => {
    const warn = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const healthJournal = {
      record: vi.fn(async () => {
        throw new Error("journal unavailable");
      })
    };
    const scheduler = new GardenScheduler(
      eventLog,
      {
        warn
      },
      healthJournal
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "[garden] tier violation health journal record failed",
      expect.objectContaining({
        taskId: "task-tier-1",
        error: "journal unavailable"
      })
    );
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("rejects a higher-priority tier violation before dispatching a later valid task", async () => {
    const { scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        priority: 50
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-0",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0,
        priority: 40
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();
    expect(scheduler.queueDepth).toBe(1);
    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toMatchObject({
      task_id: "task-tier-0"
    });
  });

  it("allows auditor to dispatch inherited tier-0 work", async () => {
    const { scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-0",
        task_kind: GardenTaskKind.HOT_INDEX_DEMOTION,
        required_tier: GardenTier.TIER_0
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({
      task_id: "task-tier-0"
    });
  });

  it("allows librarian to dispatch tier-2 work", async () => {
    const { scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-tier-2",
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        required_tier: GardenTier.TIER_2
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({
      task_id: "task-tier-2"
    });
  });

  it("dispatches matching task kinds without lower-role tier rejection", async () => {
    const { eventLog, scheduler } = createScheduler();
    scheduler.enqueue(
      createTask({
        task_id: "task-plasticity",
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        required_tier: GardenTier.TIER_2,
        priority: 50
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-janitor",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0,
        priority: 40
      })
    );

    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.JANITOR, [GardenTaskKind.TTL_CLEANUP])
    ).resolves.toMatchObject({ task_id: "task-janitor" });
    expect(scheduler.queueDepth).toBe(1);
    expect(eventLog.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
        entity_id: "task-plasticity"
      })
    );

    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.LIBRARIAN, [
        GardenTaskKind.PATH_PLASTICITY_UPDATE
      ])
    ).resolves.toMatchObject({ task_id: "task-plasticity" });
  });

  it("orders queued tasks by priority desc, created_at asc, then task_id asc", async () => {
    const { scheduler } = createScheduler();
    scheduler.enqueue(createTask({ task_id: "task-c", priority: 10, created_at: "2026-03-27T00:00:02.000Z" }));
    scheduler.enqueue(createTask({ task_id: "task-a", priority: 30, created_at: "2026-03-27T00:00:01.000Z" }));
    scheduler.enqueue(createTask({ task_id: "task-b", priority: 30, created_at: "2026-03-27T00:00:01.000Z" }));

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({ task_id: "task-a" });
    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({ task_id: "task-b" });
    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).resolves.toMatchObject({ task_id: "task-c" });
  });

  it("skips cooling tier-1 work and dispatches it after the cooling window expires", async () => {
    let now = "2026-03-27T00:00:00.000Z";
    const { scheduler } = createScheduler({
      coolingPeriodMs: 60_000,
      now: () => now
    });
    const task = createTask({
      task_id: "task-green",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1,
      target_object_refs: ["memory-1"]
    });
    scheduler.enqueue(task);

    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({ task_id: "task-green" });
    await scheduler.reportCompletion(
      createResult({
        task_id: "task-green",
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
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toBeNull();

    now = "2026-03-27T00:02:00.000Z";
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({ task_id: "task-green-2" });
  });

  it("continues scanning past cooling tier-1 work to a later dispatchable task", async () => {
    let now = "2026-03-27T00:00:00.000Z";
    const { scheduler } = createScheduler({
      coolingPeriodMs: 60_000,
      now: () => now
    });

    await scheduler.reportCompletion(
      createResult({
        task_id: "task-cooling",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        role: GardenRole.AUDITOR,
        tier: GardenTier.TIER_1,
        objects_affected: ["memory-1"]
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-cooling",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        priority: 50,
        target_object_refs: ["memory-1"]
      })
    );
    scheduler.enqueue(
      createTask({
        task_id: "task-fallback",
        task_kind: GardenTaskKind.HOT_INDEX_DEMOTION,
        required_tier: GardenTier.TIER_0,
        priority: 40
      })
    );

    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({ task_id: "task-fallback" });
    now = "2026-03-27T00:02:00.000Z";
    await expect(scheduler.dispatchNext(GardenRole.AUDITOR)).resolves.toMatchObject({ task_id: "task-cooling" });
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
        in_flight_total: 0,
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

  it("does not remove a tier-violation task when the reject append fails", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
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
        task_id: "task-invalid",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1,
        priority: 50
      })
    );
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
});

function createScheduler(
  config: {
    readonly coolingPeriodMs?: number;
    readonly now?: () => string;
    readonly backlogWarningThresholds?: {
      readonly warning_queue_depth: number;
      readonly warning_rearm_depth: number;
    };
  } = {}
) {
  const eventLog = {
    append: vi.fn(async () => undefined)
  };
  const healthJournal = {
    record: vi.fn(async () => undefined)
  };

  return {
    eventLog,
    healthJournal,
    scheduler: new GardenScheduler(eventLog, config, healthJournal)
  };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}

function createResult(overrides: Partial<GardenTaskResult> = {}): GardenTaskResult {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    role: GardenRole.JANITOR,
    tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    success: true,
    objects_affected: [],
    audit_entries: [],
    error_message: null,
    completed_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}

function readCoolingMap(scheduler: GardenScheduler): Map<string, string> {
  return (scheduler as unknown as { coolingMap: Map<string, string> }).coolingMap;
}
