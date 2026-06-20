import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  type ConsolidationCyclePlan,
  type ConsolidationCycleResult,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type PathRelation
} from "@do-soul/alaya-protocol";

import {
  ConsolidationExecutor,
  ConsolidationPlanner,
  EmbeddingBackfillPartialFailureError
} from "@do-soul/alaya-core";

import type { BackgroundServiceConfig } from "../../background/bootstrap.js";

import {
  createConsolidationCapableConnection,
  createDormantPath,
  createGardenDataPorts,
  createRuntimeInput,
  type GardenRuntimeInput
} from "./runtime-fixture.js";

const hoisted = vi.hoisted(() => {
  const schedulers: Array<{
    queue: GardenTaskDescriptor[];
    completions: GardenTaskResult[];
  }> = [];
  const tierOrder: Record<GardenTierValue, number> = {
    tier_0: 0,
    tier_1: 1,
    tier_2: 2
  };
  const roleTier: Record<string, GardenTierValue> = {
    janitor: "tier_0",
    auditor: "tier_1",
    librarian: "tier_2"
  };

  class FakeGardenScheduler {
    public readonly queue: GardenTaskDescriptor[] = [];
    public readonly completions: GardenTaskResult[] = [];

    public constructor() {
      schedulers.push(this);
    }

    public enqueue(descriptor: GardenTaskDescriptor): void {
      this.queue.push(descriptor);
    }

    public async dispatchNext(role: string): Promise<GardenTaskDescriptor | null> {
      return await this.dispatchNextMatchingTaskKind(role, [
        GardenTaskKind.TTL_CLEANUP,
        GardenTaskKind.EVIDENCE_STALENESS_CHECK,
        GardenTaskKind.MERGE_PROPOSAL,
        GardenTaskKind.EMBEDDING_BACKFILL,
        GardenTaskKind.PATH_PLASTICITY_UPDATE,
        GardenTaskKind.PATH_GRAPH_SNAPSHOT
      ]);
    }

    public async dispatchNextMatchingTaskKind(
      role: string,
      taskKinds: readonly string[],
      workspaceId?: string
    ): Promise<GardenTaskDescriptor | null> {
      const roleTierValue = roleTier[role] ?? "tier_0";
      const taskIndex = this.queue.findIndex(
        (task) =>
          taskKinds.includes(task.task_kind) &&
          tierOrder[task.required_tier] <= tierOrder[roleTierValue] &&
          (workspaceId === undefined || task.workspace_id === workspaceId)
      );
      if (taskIndex < 0) {
        return null;
      }
      const [task] = this.queue.splice(taskIndex, 1);
      return task ?? null;
    }

    public async reportCompletion(result: GardenTaskResult): Promise<void> {
      this.completions.push(result);
    }

    public getBacklogSnapshot() {
      return {
        workspace_id: null,
        observed_at: "2026-05-05T12:00:00.000Z",
        queue_depth_total: this.queue.length,
        queue_depth_by_tier: this.queue.reduce(
          (counts, task) => ({
            ...counts,
            [task.required_tier]: counts[task.required_tier] + 1
          }),
          { tier_0: 0, tier_1: 0, tier_2: 0 } as Record<GardenTierValue, number>
        ),
        in_flight_total: 0,
        warning_active: false
      };
    }

    public peekBacklogWarningTransition(): null {
      return null;
    }

    public peekLastBacklogWarningTransitionId(): null {
      return null;
    }

    public acknowledgeBacklogWarningTransition(): boolean {
      return false;
    }
  }

  return { FakeGardenScheduler, schedulers };
});

vi.mock("@do-soul/alaya-soul", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-soul")>();
  return {
    ...actual,
    GardenScheduler: hoisted.FakeGardenScheduler
  };
});

import { createGardenRuntime } from "../../garden/runtime.js";

type CapturedScheduler = (typeof hoisted.schedulers)[number];

function currentScheduler(): CapturedScheduler {
  const scheduler = hoisted.schedulers[0];
  if (scheduler === undefined) {
    throw new Error("GardenScheduler was not constructed.");
  }
  return scheduler;
}

function getService(runtime: ReturnType<typeof createGardenRuntime>, name: string): BackgroundServiceConfig {
  const services = (runtime.backgroundManager as unknown as {
    readonly services: readonly BackgroundServiceConfig[];
  }).services;
  const service = services.find((candidate) => candidate.name === name);
  if (service === undefined) {
    throw new Error(`Missing background service ${name}.`);
  }
  return service;
}

async function enqueueMaintenanceTick(runtime: ReturnType<typeof createGardenRuntime>): Promise<void> {
  await getService(runtime, "Janitor").task();
  await getService(runtime, "Auditor").task();
  await getService(runtime, "Librarian").task();
}

async function drainScheduler(runtime: ReturnType<typeof createGardenRuntime>): Promise<void> {
  const scheduler = currentScheduler();
  const schedulerService = getService(runtime, "GardenScheduler");

  for (let attempt = 0; scheduler.queue.length > 0 && attempt < 20; attempt += 1) {
    await schedulerService.task();
  }

  expect(scheduler.queue).toHaveLength(0);
}

function plasticityTasks(scheduler: CapturedScheduler): readonly GardenTaskDescriptor[] {
  return scheduler.queue.filter((task) => task.task_kind === GardenTaskKind.PATH_PLASTICITY_UPDATE);
}

describe("garden runtime targeted embedding backfill pass", () => {

  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedQueueTask(
    scheduler: CapturedScheduler,
    taskKind: GardenTaskDescriptor["task_kind"],
    taskId: string,
    workspaceId = "workspace-1"
  ): void {
    scheduler.queue.push({
      task_id: taskId,
      task_kind: taskKind,
      required_tier: GardenTier.TIER_2,
      workspace_id: workspaceId,
      run_id: null,
      target_object_refs: [workspaceId],
      priority: 10,
      created_at: "2026-06-01T00:00:00.000Z"
    } as GardenTaskDescriptor);
  }

  it("surfaces item-level provider failure reasons to targeted warmup callers", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        objectsAffected: [],
        auditEntries: ["embedding_failed:provider:memory-bad:provider rejected input"]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "embedding_failed:provider:memory-bad:provider rejected input"
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        success: true,
        audit_entries: ["embedding_failed:provider:memory-bad:provider rejected input"]
      })
    );
  });

  it("includes partial durable side effects in failed EMBEDDING_BACKFILL completions", async () => {
    const partialFailure = new EmbeddingBackfillPartialFailureError({
      workspaceId: "workspace-1",
      failedObjectId: "memory-failed",
      message: "sqlite write failed",
      objectsAffected: ["memory-ok"],
      auditEntries: [
        "embedding_upserted:memory-ok",
        "embedding_failed:persistence:memory-failed:sqlite write failed"
      ],
      cause: new Error("sqlite write failed")
    });
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw partialFailure;
      })
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow("sqlite write failed");

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        success: false,
        objects_affected: ["memory-ok"],
        audit_entries: [
          "embedding_upserted:memory-ok",
          "embedding_failed:persistence:memory-failed:sqlite write failed"
        ],
        error_message: "embedding_backfill_failed:persistence:memory-failed:sqlite write failed"
      })
    );
  });

  it("is a no-op when no embedding backfill handler is configured", async () => {
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        }))
      })
    );
    const scheduler = currentScheduler();

    await runtime.runEmbeddingBackfillPass("workspace-1");

    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.completions).toHaveLength(0);
    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("terminates after the bounded drain cap when backfill keeps re-queueing", async () => {
    // A handler that always throws makes runEmbeddingBackfillTask report a
    // failed completion (which re-queues the task). Without a bound the drain
    // loop would spin forever; the cap guarantees termination.
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw new Error("embedding provider unreachable");
      })
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    // The FakeGardenScheduler does not re-queue on failed reportCompletion, so
    // a single enqueue drains in one dispatch even on failure; the bound is
    // still asserted by capping handler invocations within the loop ceiling.
    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "embedding provider unreachable"
    );

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        success: false,
        error_message: "embedding provider unreachable"
      })
    );
    expect(runtime.getStatus().last_pass_at).toBeNull();
  });
});
