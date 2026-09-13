import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTaskKind,
  GardenTier} from "@do-soul/alaya-protocol";
import {
  GardenScheduler,
  InMemoryGardenTaskRepo,
  MAX_PENDING_BACKLOG_WARNING_TRANSITIONS
} from "../../../garden/scheduling/scheduler.js";

import {
  createTask,
  enqueueVisibleTierViolation} from "./garden-scheduler-fixtures.js";

describe("GardenScheduler", () => {  it("does not remove a tier-violation task when the reject append fails", async () => {
    const append = vi.fn(async (_event: unknown) => undefined);
    const eventLog = {
      append,
      appendManyAtomic: vi.fn(async (events: readonly unknown[]) => {
        for (const event of events) await append(event);
      })
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

    eventLog.appendManyAtomic.mockRejectedValueOnce(new Error("tier violation append failed"));

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

  it("does not retain a partial tier-violation audit when the completion append fails", async () => {
    const committed: Array<{ readonly event_type: string }> = [];
    const eventLog = {
      append: vi.fn(async (event: { readonly event_type: string }) => {
        if (event.event_type === "soul.garden.task_completed") {
          throw new Error("completion append failed");
        }
        committed.push(event);
      }),
      appendManyAtomic: vi.fn(async (events: readonly { readonly event_type: string }[]) => {
        const staged: Array<{ readonly event_type: string }> = [];
        for (const event of events) {
          if (event.event_type === "soul.garden.task_completed") {
            throw new Error("completion append failed");
          }
          staged.push(event);
        }
        committed.push(...staged);
      })
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(eventLog, {}, null, repo);
    enqueueVisibleTierViolation(repo, {
      task_id: "task-invalid-batch",
      task_kind: GardenTaskKind.GREEN_MAINTENANCE,
      required_tier: GardenTier.TIER_1
    });

    await expect(scheduler.dispatchNext(GardenRole.JANITOR)).rejects.toThrow(
      "completion append failed"
    );
    expect(committed).toEqual([]);
    expect(repo.findById("task-invalid-batch")).toMatchObject({ status: "pending" });
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

describe("GardenScheduler backlog transition bound", () => {
  it("keeps unacked backlog warning transitions bounded across repeated arm/clear flips", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined),
      appendManyAtomic: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    const scheduler = new GardenScheduler(
      eventLog,
      {
        now: () => "2026-04-23T08:00:00.000Z",
        backlogWarningThresholds: {
          warning_queue_depth: 0,
          warning_rearm_depth: 1
        }
      },
      null,
      repo
    );

    for (let index = 0; index < MAX_PENDING_BACKLOG_WARNING_TRANSITIONS + 8; index += 1) {
      scheduler.enqueue(
        createTask({
          task_id: `task-flip-${index}`,
          required_tier: GardenTier.TIER_0,
          priority: 40
        })
      );
      await scheduler.dispatchNext(GardenRole.JANITOR);
    }

    let pending = 0;
    let current = scheduler.peekBacklogWarningTransition();
    while (current !== null) {
      pending += 1;
      expect(scheduler.acknowledgeBacklogWarningTransition(current.transition_id)).toBe(true);
      current = scheduler.peekBacklogWarningTransition();
    }
    expect(pending).toBe(MAX_PENDING_BACKLOG_WARNING_TRANSITIONS);
  });

  it("removes completed in-memory garden tasks so the repo stays bounded", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);

    for (let index = 0; index < 20; index += 1) {
      const taskId = `task-done-${index}`;
      repo.enqueue({
        id: taskId,
        workspace_id: "workspace-1",
        role: GardenRole.JANITOR,
        kind: GardenTaskKind.TTL_CLEANUP,
        payload: createTask({ task_id: taskId }),
        created_at: "2026-03-27T00:00:00.000Z"
      });
      await repo.claimAtomic(taskId, "worker-a", "2026-03-27T00:01:00.000Z");
      await repo.completeWithEvents(
        taskId,
        { status: "completed", completed_at: "2026-03-27T00:02:00.000Z" },
        [],
        "worker-a"
      );
      expect(repo.findById(taskId)).toBeNull();
    }

    expect(repo.countBacklog()).toEqual([]);
  });
});
