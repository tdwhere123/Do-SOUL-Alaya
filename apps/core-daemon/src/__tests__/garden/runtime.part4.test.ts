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
import { StorageError } from "@do-soul/alaya-storage";
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
    reportCompletion(result: GardenTaskResult): Promise<void>;
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

  it("dispatches only EMBEDDING_BACKFILL and never touches other Librarian kinds already queued", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        objectsAffected: ["memory-1", "memory-2"],
        auditEntries: ["embedding_upserted:memory-1", "embedding_upserted:memory-2"]
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

    seedQueueTask(scheduler, GardenTaskKind.BULK_ENRICH, "task-bulk-enrich");
    seedQueueTask(scheduler, GardenTaskKind.MERGE_PROPOSAL, "task-merge");
    seedQueueTask(scheduler, GardenTaskKind.PATH_PLASTICITY_UPDATE, "task-plasticity");
    seedQueueTask(scheduler, GardenTaskKind.PATH_GRAPH_SNAPSHOT, "task-snapshot");
    seedQueueTask(scheduler, GardenTaskKind.CONSOLIDATION_CYCLE, "task-consolidation");

    await runtime.runEmbeddingBackfillPass("workspace-1");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-1" })
    );

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: true
      })
    );

    const remainingKinds = scheduler.queue.map((task) => task.task_kind).sort();
    expect(remainingKinds).toEqual(
      [
        GardenTaskKind.BULK_ENRICH,
        GardenTaskKind.CONSOLIDATION_CYCLE,
        GardenTaskKind.MERGE_PROPOSAL,
        GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        GardenTaskKind.PATH_PLASTICITY_UPDATE
      ].sort()
    );

    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("drains only the requested workspace's EMBEDDING_BACKFILL and leaves another workspace's same-kind task queued", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async (task: { workspace_id: string }) => ({
        objectsAffected: [`memory-${task.workspace_id}`],
        auditEntries: [`embedding_upserted:memory-${task.workspace_id}`]
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

    seedQueueTask(scheduler, GardenTaskKind.EMBEDDING_BACKFILL, "task-backfill-B", "workspace-B");

    await runtime.runEmbeddingBackfillPass("workspace-A");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-A" })
    );

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        workspace_id: "workspace-A",
        success: true
      })
    );

    const remaining = scheduler.queue.filter(
      (task) => task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.workspace_id).toBe("workspace-B");
  });

  it("drains an existing same-workspace EMBEDDING_BACKFILL without enqueueing a duplicate", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async (task: { workspace_id: string }) => ({
        objectsAffected: [`memory-${task.workspace_id}`],
        auditEntries: [`embedding_upserted:memory-${task.workspace_id}`]
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
    seedQueueTask(scheduler, GardenTaskKind.EMBEDDING_BACKFILL, "task-existing", "workspace-A");

    await runtime.runEmbeddingBackfillPass("workspace-A");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-existing", workspace_id: "workspace-A" })
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_id: "task-existing",
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        workspace_id: "workspace-A",
        success: true
      })
    );
    expect(scheduler.queue.filter((task) => task.workspace_id === "workspace-A")).toEqual([]);
  });

  it("surfaces provider-unavailable audit reasons to targeted warmup callers", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        objectsAffected: [],
        auditEntries: ["embedding_backfill_skipped:provider_unavailable"]
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
      "embedding_backfill_skipped:provider_unavailable"
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        success: true,
        audit_entries: ["embedding_backfill_skipped:provider_unavailable"]
      })
    );
  });

  it("logs a bounded secret-safe causal chain and the failing backfill phase", async () => {
    const warn = vi.fn();
    const cause = Object.assign(
      new Error("sqlite write failed at /home/alice/private.db token=super-secret"),
      { code: "SQLITE_CONSTRAINT" }
    );
    const error = new Error("Failed to append event log entry.", { cause });
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler: { handle: vi.fn(async () => { throw error; }) }
      }),
      warn
    });

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "Failed to append event log entry."
    );

    expect(warn).toHaveBeenCalledWith(
      "embedding backfill task failed; continuing Garden background pass",
      expect.objectContaining({
        workspace_id: "workspace-1",
        phase: "backfill",
        error: {
          name: "Error",
          code: null,
          message: "Failed to append event log entry.",
          cause_chain: [{
            name: "Error",
            code: "SQLITE_CONSTRAINT",
            message: expect.not.stringMatching(/alice|private\.db|super-secret/u)
          }]
        }
      })
    );
    const completion = currentScheduler().completions.at(-1);
    expect(completion?.error_message).not.toMatch(/alice|private\.db|super-secret/u);
  });

  it("identifies coherence, answers_with, and completion warning phases", async () => {
    const warn = vi.fn();
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler: {
          handle: vi.fn(async () => ({
            objectsAffected: ["memory-1", "memory-2"],
            auditEntries: []
          }))
        }
      }),
      coherenceEdgeProducerPort: {
        crystallizeForBackfill: vi.fn(async () => { throw new Error("coherence failed"); })
      },
      answersWithEdgeProducerPort: {
        crystallizeForBackfill: vi.fn(async () => { throw new Error("answers failed"); })
      },
      warn
    });
    const scheduler = currentScheduler();
    const reportCompletion = scheduler.reportCompletion.bind(scheduler);
    const sqliteBusy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY"
    });
    vi.spyOn(scheduler, "reportCompletion")
      .mockRejectedValueOnce(
        new StorageError("QUERY_FAILED", "Failed to append event log entry.", sqliteBusy)
      )
      .mockImplementation(reportCompletion);

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).resolves.toBeUndefined();

    expect(warn.mock.calls.map((call) => call[1]?.phase)).toEqual([
      "coherence",
      "answers_with",
      "completion"
    ]);
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({ success: true })
    );
  });

  it("fails loud without rewriting the work outcome when completion retries exhaust", async () => {
    const warn = vi.fn();
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        embeddingBackfillHandler: {
          handle: vi.fn(async () => ({ objectsAffected: ["memory-1"], auditEntries: [] }))
        }
      }),
      warn
    });
    const scheduler = currentScheduler();
    vi.spyOn(scheduler, "reportCompletion").mockRejectedValue(
      Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" })
    );

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      /completion persistence failed/u
    );
    expect(warn).not.toHaveBeenCalledWith(
      "embedding backfill task failed; continuing Garden background pass",
      expect.anything()
    );
  });
});
