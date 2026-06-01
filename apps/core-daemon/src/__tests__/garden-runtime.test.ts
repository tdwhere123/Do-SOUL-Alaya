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
  type PathGraphSnapshot,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  ConsolidationExecutor,
  ConsolidationPlanner,
  EmbeddingBackfillPartialFailureError
} from "@do-soul/alaya-core";
import type { BackgroundServiceConfig } from "../background/bootstrap.js";

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

import { createGardenRuntime } from "../garden-runtime.js";

type GardenRuntimeInput = Parameters<typeof createGardenRuntime>[0];
type CapturedScheduler = (typeof hoisted.schedulers)[number];

describe("garden runtime path plasticity queue", () => {
  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
  });

  it("dedupes pending path plasticity workspaces and re-enqueues after Librarian completion clears the marker", async () => {
    const computeAndApplyPlasticity = vi.fn(async () => ({
      reinforced: 1,
      weakened: 0,
      retired: 0,
      affectedPathIds: ["path-1"]
    }));
    const runtime = createGardenRuntime(createRuntimeInput({ computeAndApplyPlasticity }));
    const scheduler = currentScheduler();

    await enqueueMaintenanceTick(runtime);
    await enqueueMaintenanceTick(runtime);

    const pendingPlasticityTasks = plasticityTasks(scheduler);
    expect(pendingPlasticityTasks).toHaveLength(1);
    expect(pendingPlasticityTasks[0]).toMatchObject({
      task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1"
    });
    expect(runtime.backlogTelemetrySource.getBacklogSnapshot().queue_depth_by_tier).toMatchObject({
      tier_0: 2,
      tier_1: 2,
      tier_2: 5
    });

    await drainScheduler(runtime);

    expect(computeAndApplyPlasticity).toHaveBeenCalledTimes(1);
    expect(computeAndApplyPlasticity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sinceIso: pendingPlasticityTasks[0]?.target_object_refs[0],
        untilIso: pendingPlasticityTasks[0]?.target_object_refs[1]
      })
    );

    await enqueueMaintenanceTick(runtime);

    expect(plasticityTasks(scheduler)).toHaveLength(1);

    await drainScheduler(runtime);

    expect(computeAndApplyPlasticity).toHaveBeenCalledTimes(2);
  });

  it("clears the pending marker after a Librarian path plasticity failure result", async () => {
    const computeAndApplyPlasticity = vi
      .fn()
      .mockRejectedValueOnce(new Error("plasticity exploded"))
      .mockResolvedValueOnce({
        reinforced: 0,
        weakened: 1,
        retired: 0,
        affectedPathIds: ["path-2"]
      });
    const runtime = createGardenRuntime(createRuntimeInput({ computeAndApplyPlasticity }));
    const scheduler = currentScheduler();

    await enqueueMaintenanceTick(runtime);
    await drainScheduler(runtime);

    expect(computeAndApplyPlasticity).toHaveBeenCalledTimes(1);
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: false,
        error_message: "plasticity exploded"
      })
    );

    await enqueueMaintenanceTick(runtime);

    expect(plasticityTasks(scheduler)).toHaveLength(1);

    await drainScheduler(runtime);

    expect(computeAndApplyPlasticity).toHaveBeenCalledTimes(2);
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: true
      })
    );
  });

  it("records embedding backfill failures without aborting the scheduler pass", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw new Error("Embedding request transport failed for host embedding.example.test. cause=EHOSTUNREACH");
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
    const schedulerService = getService(runtime, "GardenScheduler");

    await enqueueMaintenanceTick(runtime);
    await schedulerService.task();
    await expect(schedulerService.task()).resolves.not.toThrow();

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: false,
        error_message: "Embedding request transport failed for host embedding.example.test. cause=EHOSTUNREACH"
      })
    );

    await getService(runtime, "Librarian").task();

    expect(scheduler.queue.some((task) => task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL)).toBe(true);
  });

  it("does not leave a workspace pending when watermark lookup fails before enqueue", async () => {
    const computeAndApplyPlasticity = vi.fn(async () => ({
      reinforced: 0,
      weakened: 0,
      retired: 0,
      affectedPathIds: []
    }));
    const findByWorkspaceId = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("watermark read failed");
      })
      .mockReturnValue(null);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity,
        pathPlasticityWatermarkRepo: {
          findByWorkspaceId,
          upsert: vi.fn((record) => record)
        }
      })
    );
    const scheduler = currentScheduler();

    await expect(getService(runtime, "Librarian").task()).rejects.toThrow("watermark read failed");
    expect(plasticityTasks(scheduler)).toHaveLength(0);

    await getService(runtime, "Librarian").task();

    expect(findByWorkspaceId).toHaveBeenCalledTimes(2);
    expect(plasticityTasks(scheduler)).toHaveLength(1);
    expect(plasticityTasks(scheduler)[0]).toMatchObject({
      task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1"
    });
  });

  it("updates Garden status after scheduled background services complete", async () => {
    const runtime = createGardenRuntime(createRuntimeInput({
      computeAndApplyPlasticity: vi.fn(async () => ({
        reinforced: 0,
        weakened: 0,
        retired: 0,
        affectedPathIds: []
      }))
    }));

    expect(runtime.getStatus().last_pass_at).toBeNull();

    await getService(runtime, "Janitor").task();

    expect(runtime.getStatus().last_pass_at).toEqual(expect.any(String));
  });

  it("records a default-workspace Garden pass when no workspaces exist yet", async () => {
    const healthJournalAppend = vi.fn(async () => undefined);
    const runtime = createGardenRuntime(createRuntimeInput({
      computeAndApplyPlasticity: vi.fn(async () => ({
        reinforced: 0,
        weakened: 0,
        retired: 0,
        affectedPathIds: []
      })),
      healthJournalRepo: {
        append: healthJournalAppend
      } as unknown as GardenRuntimeInput["healthJournalRepo"],
      workspaceRepo: {
        list: vi.fn(async () => [])
      } as unknown as GardenRuntimeInput["workspaceRepo"]
    }));

    await runtime.runBackgroundPass();

    expect(healthJournalAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: "default",
        summary: "Garden background pass completed"
      })
    );
  });

  it("prioritizes Auditor evidence staleness by path verification bias", async () => {
    const revokeOrder: string[] = [];
    const gardenDataPorts = createGardenDataPorts({
      evidenceCheckPort: {
        findMemoriesWithStaleEvidence: vi.fn(async () => [
          { memory_entry_id: "memory-low", stale_evidence_refs: ["evidence-1"] },
          { memory_entry_id: "memory-high", stale_evidence_refs: ["evidence-2"] }
        ])
      },
      // Only revokeGreen is exercised here; createGardenDataPorts spreads
      // this over full greenMaintenancePort defaults, so the partial
      // override is completed at runtime.
      greenMaintenancePort: {
        revokeGreen: vi.fn((memoryId: string) => {
          revokeOrder.push(memoryId);
          return { affected: 1 };
        })
      } as unknown as GardenRuntimeInput["gardenDataPorts"]["greenMaintenancePort"]
    });
    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        gardenDataPorts,
        pathRelationRepo: {
          findActive: vi.fn(async () => []),
          findByAnchors: vi.fn(async (_workspaceId: string, anchors: readonly { readonly object_id: string }[]) =>
            anchors.some((anchor) => anchor.object_id === "memory-high")
              ? [
                  {
                    lifecycle: { status: "active" },
                    effect_vector: { verification_bias: 0.9 }
                  }
                ]
              : [])
        } as unknown as GardenRuntimeInput["pathRelationRepo"]
      })
    );

    await getService(runtime, "Auditor").task();
    await getService(runtime, "GardenScheduler").task();

    expect(revokeOrder).toEqual(["memory-high", "memory-low"]);
  });
});

describe("garden runtime consolidation cycle", () => {
  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the ConsolidationPlanner and feeds its non-empty plan into the executor", async () => {
    // A dormant cluster that survives the importance gate: two recall_allowed
    // dormant paths over the same relation_kind + anchors. The richer one is the
    // survivor, the bare one a deletable loser -> planCycle emits one merge.
    const survivor = createDormantPath({
      path_id: "path-survivor",
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const loser = createDormantPath({
      path_id: "path-loser",
      legitimacy: { evidence_basis: ["ev-3"], governance_class: "recall_allowed" }
    });

    const findDormant = vi.fn(
      async (): Promise<readonly Readonly<PathRelation>[]> => [survivor, loser]
    );

    // Let the REAL planner run so the captured plan is genuinely the planner's
    // output (non-empty merges), not the retired empty literal. The executor is
    // spied so the test asserts the wiring without a live DB / mutation path.
    const planCycleSpy = vi.spyOn(ConsolidationPlanner.prototype, "planCycle");
    const runCycleSpy = vi
      .spyOn(ConsolidationExecutor.prototype, "runCycle")
      .mockImplementation(async (input): Promise<ConsolidationCycleResult> => {
        const mergesCommitted = input.plan.merges?.length ?? 0;
        return {
          workspace_id: input.plan.workspace_id,
          committed_at: "2026-05-20T12:00:00.000Z",
          promotions_committed: 0,
          retirements_committed: 0,
          governance_changes_committed: 0,
          direction_changes_committed: 0,
          merges_committed: mergesCommitted,
          fuse_outcome: "ok"
        };
      });

    const runtime = createGardenRuntime(
      createRuntimeInput({
        computeAndApplyPlasticity: vi.fn(async () => ({
          reinforced: 0,
          weakened: 0,
          retired: 0,
          affectedPathIds: []
        })),
        databaseConnection: createConsolidationCapableConnection(),
        pathRelationRepo: {
          findActive: vi.fn(async () => []),
          findByAnchors: vi.fn(async () => []),
          findDormant
        } as unknown as GardenRuntimeInput["pathRelationRepo"]
      })
    );
    const scheduler = currentScheduler();

    // Librarian enqueues the CONSOLIDATION_CYCLE task; the scheduler pass
    // dispatches and runs it through runConsolidationCycleTask.
    await getService(runtime, "Librarian").task();
    await drainScheduler(runtime);

    // The planner was constructed and asked to plan the workspace.
    expect(planCycleSpy).toHaveBeenCalledWith("workspace-1");
    expect(findDormant).toHaveBeenCalledWith("workspace-1", expect.any(String));

    // The executor received the planner's plan, not an empty literal.
    expect(runCycleSpy).toHaveBeenCalledTimes(1);
    const [{ triggerSource, plan }] = runCycleSpy.mock.calls[0]!;
    expect(triggerSource).toBe("native_surface_drift");
    const planned: ConsolidationCyclePlan = await planCycleSpy.mock.results[0]!.value;
    expect(plan).toBe(planned);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-survivor");
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-loser"]);

    // The cycle ran a real plan: merges committed > 0, reported success.
    const result = await runCycleSpy.mock.results[0]!.value;
    expect(result.merges_committed).toBe(1);
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.CONSOLIDATION_CYCLE,
        role: GardenRole.LIBRARIAN,
        success: true,
        audit_entries: ["consolidation_cycle:fuse_ok"]
      })
    );
  });
});

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

    // The targeted pass must leave non-embedding maintenance kinds in the queue.
    seedQueueTask(scheduler, GardenTaskKind.BULK_ENRICH, "task-bulk-enrich");
    seedQueueTask(scheduler, GardenTaskKind.MERGE_PROPOSAL, "task-merge");
    seedQueueTask(scheduler, GardenTaskKind.PATH_PLASTICITY_UPDATE, "task-plasticity");
    seedQueueTask(scheduler, GardenTaskKind.PATH_GRAPH_SNAPSHOT, "task-snapshot");
    seedQueueTask(scheduler, GardenTaskKind.CONSOLIDATION_CYCLE, "task-consolidation");

    await runtime.runEmbeddingBackfillPass("workspace-1");

    // The handler ran and reached all-ready for the workspace in one O(n) call.
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-1" })
    );

    // ONLY the self-enqueued EMBEDDING_BACKFILL was completed.
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: true
      })
    );

    // Every other maintenance kind is left untouched in the queue: the targeted
    // drain did not run BULK_ENRICH / merge / plasticity / snapshot /
    // consolidation that the full Garden pass would have run.
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

    // The targeted drain is not a Garden maintenance cadence tick, so it must
    // not advance last_pass_at the way runBackgroundPass does.
    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("drains only the requested workspace's EMBEDDING_BACKFILL and leaves another workspace's same-kind task queued", async () => {
    // invariant: targeted embedding warmup is workspace-scoped even when another
    // workspace already has pending same-kind work.
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

    // Older pending EMBEDDING_BACKFILL for a different workspace (workspace-B).
    seedQueueTask(scheduler, GardenTaskKind.EMBEDDING_BACKFILL, "task-backfill-B", "workspace-B");

    await runtime.runEmbeddingBackfillPass("workspace-A");

    // The handler ran exactly once, for the requested workspace only.
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-A" })
    );

    // Only workspace-A's backfill was completed.
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        workspace_id: "workspace-A",
        success: true
      })
    );

    // The other workspace's same-kind task is untouched in the queue.
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

function createConsolidationCapableConnection(): GardenRuntimeInput["databaseConnection"] {
  // A prepare()-bearing connection also makes createGardenRuntime construct a
  // SqliteGardenTaskRepo (its abandoned-claim reclaim calls statement.all), so
  // every fake statement answers get/all/run with empty results: an empty
  // budget table (get -> undefined) means no cooldown, so the cycle proceeds.
  const statement = { get: () => undefined, all: () => [], run: () => undefined };
  return {
    prepare: () => statement
  } as unknown as GardenRuntimeInput["databaseConnection"];
}

function createDormantPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "obj-a" },
      target_anchor: { kind: "object", object_id: "obj-b" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["seed-why"]
    },
    effect_vector: {
      salience: 0,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.05,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "dormant",
      retirement_rule: "retire_after_cooldown"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-10T00:00:00.000Z",
    ...overrides
  } as PathRelation;
}

function createRuntimeInput(options: {
  // Test mocks return only the result fields the garden runtime reads
  // (reinforced/weakened/retired/affectedPathIds); the full
  // PathPlasticityComputeResult shape is cast on at the assignment below.
  readonly computeAndApplyPlasticity: (
    params: Parameters<
      NonNullable<GardenRuntimeInput["pathPlasticityService"]>["computeAndApplyPlasticity"]
    >[0]
  ) => Promise<{
    readonly reinforced: number;
    readonly weakened: number;
    readonly retired: number;
    readonly affectedPathIds: readonly string[];
  }>;
  readonly gardenDataPorts?: GardenRuntimeInput["gardenDataPorts"];
  readonly healthJournalRepo?: GardenRuntimeInput["healthJournalRepo"];
  readonly embeddingBackfillHandler?: GardenRuntimeInput["embeddingBackfillHandler"];
  readonly pathRelationRepo?: GardenRuntimeInput["pathRelationRepo"];
  readonly pathPlasticityWatermarkRepo?: GardenRuntimeInput["pathPlasticityWatermarkRepo"];
  readonly workspaceRepo?: GardenRuntimeInput["workspaceRepo"];
  // A prepare()-bearing connection makes createGardenRuntime construct the
  // ConsolidationExecutor (else it is null and the consolidation cycle is
  // skipped). Default {} keeps the existing tests on the null-executor path.
  readonly databaseConnection?: GardenRuntimeInput["databaseConnection"];
}): GardenRuntimeInput {
  let latestSnapshot: PathGraphSnapshot | null = null;
  const publish = vi.fn(async (entry: Record<string, unknown>) => ({
    event_id: `event-${publish.mock.calls.length + 1}`,
    created_at: "2026-05-05T12:00:00.000Z",
    revision: 1,
    ...entry
  }));

  return {
    databaseConnection:
      options.databaseConnection ?? ({} as GardenRuntimeInput["databaseConnection"]),
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      // Not consumed by createGardenRuntime (only warning_queue_depth /
      // warning_rearm_depth are read); present to satisfy
      // GardenBacklogThresholds.
      snapshot_interval_ms: 1000
    },
    eventLogRepo: {} as GardenRuntimeInput["eventLogRepo"],
    eventPublisher: {
      publish,
      appendManyWithMutation: vi.fn(
        async (
          entries: readonly Record<string, unknown>[],
          mutate: (entries: readonly Record<string, unknown>[]) => unknown
        ) =>
          mutate(
            entries.map((entry, index) => ({
              event_id: `event-many-${index + 1}`,
              created_at: "2026-05-05T12:00:00.000Z",
              revision: 1,
              ...entry
            }))
          )
      )
    } as unknown as GardenRuntimeInput["eventPublisher"],
    gardenDataPorts: options.gardenDataPorts ?? createGardenDataPorts(),
    healthJournalRepo:
      options.healthJournalRepo ??
      ({
        append: vi.fn(async () => undefined)
      } as unknown as GardenRuntimeInput["healthJournalRepo"]),
    handoffGapRepo: {
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn()
    } as unknown as GardenRuntimeInput["handoffGapRepo"],
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: {
      findLatest: vi.fn(async () => latestSnapshot),
      create: vi.fn((snapshot: PathGraphSnapshot) => {
        latestSnapshot = snapshot;
      }),
      findHistory: vi.fn(async () => (latestSnapshot === null ? [] : [latestSnapshot])),
      deleteOlderThan: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["pathGraphSnapshotRepo"],
    pathRelationRepo:
      options.pathRelationRepo ??
      ({
        findActive: vi.fn(async () => []),
        findByAnchors: vi.fn(async () => [])
      } as unknown as GardenRuntimeInput["pathRelationRepo"]),
    ...(options.pathPlasticityWatermarkRepo === undefined
      ? {}
      : { pathPlasticityWatermarkRepo: options.pathPlasticityWatermarkRepo }),
    pathPlasticityService: {
      computeAndApplyPlasticity:
        options.computeAndApplyPlasticity as NonNullable<
          GardenRuntimeInput["pathPlasticityService"]
        >["computeAndApplyPlasticity"]
    },
    ...(options.embeddingBackfillHandler === undefined
      ? {}
      : { embeddingBackfillHandler: options.embeddingBackfillHandler }),
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as GardenRuntimeInput["strongRefService"],
    workspaceRepo:
      options.workspaceRepo ??
      ({
        list: vi.fn(async () => [{ workspace_id: "workspace-1" }])
      } as unknown as GardenRuntimeInput["workspaceRepo"])
  };
}

function createGardenDataPorts(
  overrides: Partial<GardenRuntimeInput["gardenDataPorts"]> = {}
): GardenRuntimeInput["gardenDataPorts"] {
  return {
    evidenceCheckPort: overrides.evidenceCheckPort ?? { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
    pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
    greenMaintenancePort: {
      findExpiringGreenStatuses: vi.fn(async () => []),
      renewGreenPassiveStable: vi.fn(async () => undefined),
      requestActiveVerification: vi.fn(async () => undefined),
      revokeGreen: vi.fn(() => ({ affected: 0 })),
      ...(overrides.greenMaintenancePort ?? {})
    },
    bootstrappingPort: {
      assessColdStart: vi.fn(async () => ({
        is_cold_start: false,
        memory_count: 10,
        claim_count: 5
      })),
      generateDraftCandidates: vi.fn(async () => []),
      findHighFrequencyPatterns: vi.fn(async () => []),
      createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
      hasPendingSynthesisCandidate: vi.fn(async () => false)
    },
    tieringPort: {
      findHotDemotionCandidates: vi.fn(async () => []),
      demoteToWarm: vi.fn(async () => undefined)
    },
    mergePort: {
      findMergeCandidates: vi.fn(async () => []),
      hasPendingMergeProposal: vi.fn(async () => false),
      createMergeProposal: vi.fn(async () => ({ proposal_id: "proposal-1" })),
      findTemplateClusters: vi.fn(async () => []),
      hasPendingTemplateProposal: vi.fn(async () => false),
      createTemplateCandidate: vi.fn(async () => ({ candidate_id: "template-1" }))
    },
    neighborPort: { findSubjectNeighbors: vi.fn(async () => []) },
    compressionPort: {
      findCompressiblePaths: vi.fn(async () => []),
      createCompressionCandidate: vi.fn(async () => ({ candidate_id: "compression-1" }))
    },
    synthesisPort: {
      findSynthesisCandidateClusters: vi.fn(async () => []),
      hasPendingSynthesisForSubject: vi.fn(async () => false),
      createSynthesisReviewCandidate: vi.fn(async () => ({ candidate_id: "synthesis-1" }))
    }
  } as GardenRuntimeInput["gardenDataPorts"];
}

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
