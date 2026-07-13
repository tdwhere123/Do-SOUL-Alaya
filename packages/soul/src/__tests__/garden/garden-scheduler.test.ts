import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  GardenEventType} from "@do-soul/alaya-protocol";
import { GardenScheduler, InMemoryGardenTaskRepo } from "../../garden/scheduler.js";

import {
  createResult,
  createScheduler,
  createTask,
  enqueueVisibleTierViolation} from "./garden-scheduler-fixtures.js";

describe("GardenScheduler", () => {  it("dispatches a tier-0 task for janitor and emits a dispatch event", async () => {
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
    const append = vi.fn(async (_event: unknown) => undefined);
    const eventLog = {
      append,
      appendManyAtomic: vi.fn(async (events: readonly unknown[]) => {
        for (const event of events) await append(event);
      })
    };
    const healthJournal = {
      record: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(eventLog, {}, healthJournal, repo);
    enqueueVisibleTierViolation(repo, {
      task_id: "task-tier-1",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1
    });

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).resolves.toBeNull();

    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TIER_VIOLATION_REJECTED,
        entity_id: "task-tier-1"
      })
    );
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_id: "task-tier-1",
        payload: expect.objectContaining({ success: false })
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
    const append = vi.fn(async (_event: unknown) => undefined);
    const eventLog = {
      append,
      appendManyAtomic: vi.fn(async (events: readonly unknown[]) => {
        for (const event of events) await append(event);
      })
    };
    const healthJournal = {
      record: vi.fn(async () => {
        throw new Error("journal unavailable");
      })
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(
      eventLog,
      {
        warn
      },
      healthJournal,
      repo
    );
    enqueueVisibleTierViolation(repo, {
      task_id: "task-tier-1",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1
    });

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
    const append = vi.fn(async (_event: unknown) => undefined);
    const eventLog = {
      append,
      appendManyAtomic: vi.fn(async (events: readonly unknown[]) => {
        for (const event of events) await append(event);
      })
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(eventLog, {}, null, repo);
    enqueueVisibleTierViolation(repo, {
      task_id: "task-tier-1",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1,
      priority: 50
    });
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

  it("rejects a task kind that is not allowed at its declared tier", () => {
    const { scheduler } = createScheduler();

    expect(() =>
      scheduler.enqueue(
        createTask({
          task_kind: GardenTaskKind.MERGE_PROPOSAL,
          required_tier: GardenTier.TIER_0
        })
      )
    ).toThrow("merge_proposal is not allowed at tier_0");
  });


  it("applies role visibility in the in-memory fallback queue", () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);

    repo.enqueue({
      id: "task-tier-0",
      workspace_id: "workspace-1",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP,
      payload: createTask({
        task_id: "task-tier-0",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0
      })
    });
    repo.enqueue({
      id: "task-tier-1",
      workspace_id: "workspace-1",
      role: GardenRole.AUDITOR,
      kind: GardenTaskKind.GREEN_MAINTENANCE,
      payload: createTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    });
    repo.enqueue({
      id: "task-tier-2",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.MERGE_PROPOSAL,
      payload: createTask({
        task_id: "task-tier-2",
        task_kind: GardenTaskKind.MERGE_PROPOSAL,
        required_tier: GardenTier.TIER_2
      })
    });

    expect(repo.peekPending(GardenRole.JANITOR).map((task) => task.id)).toEqual(["task-tier-0"]);
    expect(repo.peekPending(GardenRole.AUDITOR).map((task) => task.id)).toEqual([
      "task-tier-0",
      "task-tier-1"
    ]);
    expect(repo.peekPending(GardenRole.LIBRARIAN).map((task) => task.id)).toEqual([
      "task-tier-0",
      "task-tier-1",
      "task-tier-2"
    ]);
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

  it("quarantines a mismatched row role before the matching-dispatch tier shortcut", async () => {
    const eventLog = { append: vi.fn(async () => undefined) };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(eventLog, { warn: vi.fn() }, null, repo);
    const invalid = createTask({
      task_id: "task-invalid-routing",
      task_kind: GardenTaskKind.TTL_CLEANUP,
      required_tier: GardenTier.TIER_1,
      priority: 50
    });
    repo.enqueue({
      id: invalid.task_id,
      workspace_id: invalid.workspace_id,
      role: GardenRole.JANITOR,
      kind: invalid.task_kind,
      payload: invalid,
      created_at: invalid.created_at
    });
    scheduler.enqueue(
      createTask({
        task_id: "task-valid-routing",
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0,
        priority: 40
      })
    );

    await expect(
      scheduler.dispatchNextMatchingTaskKind(GardenRole.JANITOR, [GardenTaskKind.TTL_CLEANUP])
    ).resolves.toMatchObject({ task_id: "task-valid-routing" });
    expect(repo.findById(invalid.task_id)).toMatchObject({
      status: "failed",
      last_error_text: expect.stringContaining("does not match required tier")
    });
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_id: invalid.task_id,
        payload: expect.objectContaining({
          task_kind: GardenTaskKind.TTL_CLEANUP,
          role: GardenRole.JANITOR,
          tier: GardenTier.TIER_0,
          success: false
        })
      })
    );
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

});
