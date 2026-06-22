import { describe, expect, it, vi } from "vitest";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { InMemoryGardenTaskRepo } from "../../garden/scheduler.js";
import {
  assertReplaced,
  replaceRow
} from "../../garden/in-memory-garden-task-repo.js";
import type {
  GardenSchedulerEventLogPort,
  GardenTaskEventInput
} from "../../garden/scheduler-types.js";

type InternalRow = Parameters<typeof replaceRow>[1];

function internalRows(repo: InMemoryGardenTaskRepo): InternalRow[] {
  return (repo as unknown as { rows: InternalRow[] }).rows;
}

function descriptor(taskId: string): GardenTaskDescriptor {
  return {
    task_id: taskId,
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z"
  };
}

function enqueue(repo: InMemoryGardenTaskRepo, taskId: string): void {
  const payload = descriptor(taskId);
  repo.enqueue({
    id: taskId,
    workspace_id: payload.workspace_id,
    role: GardenRole.JANITOR,
    kind: payload.task_kind,
    payload,
    created_at: payload.created_at
  });
}

function dispatchEvent(taskId: string): GardenTaskEventInput {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
    entity_type: "garden_task",
    entity_id: taskId,
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "in-process",
    payload_json: { task_id: taskId }
  };
}

describe("InMemoryGardenTaskRepo concurrency", () => {
  it("admits exactly one winner when two claims for the same task interleave across the append yield", async () => {
    // Gate append so both claimers reach the post-read window before either commits.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let entered = 0;
    const eventLog: GardenSchedulerEventLogPort = {
      append: vi.fn(async () => {
        entered += 1;
        await gate;
      })
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    enqueue(repo, "task-1");

    const first = repo.claimAtomicWithEvents("task-1", "worker-a", "2026-03-27T00:01:00.000Z", [
      dispatchEvent("task-1")
    ]);
    const second = repo.claimAtomicWithEvents("task-1", "worker-b", "2026-03-27T00:01:00.000Z", [
      dispatchEvent("task-1")
    ]);

    // The mutex must serialize: only the lock holder runs append before the gate opens.
    // Flush queued microtasks so the first claimer reaches its gated append.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    expect(entered).toBe(1);

    releaseGate();
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "already-claimed")).toHaveLength(1);

    const claimed = repo.findById("task-1");
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.attempt_count).toBe(1);
  });

  it("serializes a burst of same-task claims to a single winner", async () => {
    const eventLog: GardenSchedulerEventLogPort = {
      append: vi.fn(async () => {
        await Promise.resolve();
      })
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    enqueue(repo, "task-1");

    const claimers = Array.from({ length: 8 }, (_unused, index) =>
      repo.claimAtomicWithEvents("task-1", `worker-${index}`, "2026-03-27T00:01:00.000Z", [
        dispatchEvent("task-1")
      ])
    );
    const results = await Promise.all(claimers);

    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(repo.findById("task-1")?.attempt_count).toBe(1);
  });

  it("replaceRow returns false for a stale shallow-copy row and assertReplaced throws", () => {
    const eventLog: GardenSchedulerEventLogPort = {
      append: vi.fn(async () => undefined)
    };
    const repo = new InMemoryGardenTaskRepo(eventLog);
    enqueue(repo, "task-1");
    const rows = internalRows(repo);
    const member = rows[0]!;

    // A live member row replaces in place.
    expect(replaceRow(rows, member, { ...member, attempt_count: 99 })).toBe(true);

    // A shallow copy is a different reference; indexOf misses it.
    const stale = { ...rows[0]! };
    expect(replaceRow(rows, stale, { ...stale, attempt_count: 1 })).toBe(false);
    expect(() => assertReplaced(false, "task-1")).toThrow(/row reference is stale/);
  });
});
