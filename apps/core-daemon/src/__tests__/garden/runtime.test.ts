import {
  resetSchedulers,
  currentScheduler,
  getService,
  enqueueMaintenanceTick,
  drainScheduler,
  plasticityTasks
} from "./runtime-scheduler-mock-fixture.js";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
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
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  ConsolidationExecutor,
  ConsolidationPlanner,
  EmbeddingBackfillPartialFailureError
} from "@do-soul/alaya-core";
import {
  createConsolidationCapableConnection,
  createDormantPath,
  createGardenDataPorts,
  createRuntimeInput,
  type GardenRuntimeInput
} from "./runtime-fixture.js";
describe("garden runtime path plasticity queue", () => {
  beforeEach(() => {
    resetSchedulers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not enqueue retired proposal tasks during the Librarian pass", async () => {
    const runtime = createGardenRuntime(createRuntimeInput());
    const scheduler = currentScheduler();
    await getService(runtime, "Librarian").task();
    expect(scheduler.queue.some(task => task.task_kind === GardenTaskKind.MERGE_PROPOSAL)).toBe(false);
    expect(scheduler.queue.some(task => task.task_kind === GardenTaskKind.TEMPLATE_CANDIDATE)).toBe(false);
    expect(scheduler.queue.some(task => task.task_kind === GardenTaskKind.PATH_COMPRESSION)).toBe(false);
    expect(scheduler.queue.some(task => task.task_kind === GardenTaskKind.PATH_GRAPH_SNAPSHOT)).toBe(true);
  });

  it("records embedding backfill failures without aborting the scheduler pass", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw new Error("Embedding request transport failed for host embedding.example.test. cause=EHOSTUNREACH");
      })
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
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
    const findByWorkspaceId = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("watermark read failed");
      })
      .mockReturnValue(null);
    const runtime = createGardenRuntime(
      createRuntimeInput({
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
    const referenceTime = "2026-05-05T12:34:56.000Z";
    const runtime = createGardenRuntime(createRuntimeInput({ now: () => referenceTime }));

    expect(runtime.getStatus().last_pass_at).toBeNull();

    await getService(runtime, "Janitor").task();

    expect(runtime.getStatus().last_pass_at).toBe(referenceTime);
    expect(currentScheduler().queue.every((task) => task.created_at === referenceTime)).toBe(true);
  });

  it("enqueues DORMANT_DEMOTION on the Janitor pass and demotes faded+idle memories (reversible, never tombstoned)", async () => {
    const setLifecycleDormant = vi.fn(async () => "demoted" as const);
    const findLowActivityActiveMemories = vi.fn(async () => [{ memory_id: "memory-faded" }]);
    const gardenDataPorts = createGardenDataPorts({
      dormantDemotionPort: {
        findLowActivityActiveMemories,
        setLifecycleDormant
      }
    });
    const runtime = createGardenRuntime(
      createRuntimeInput({
        gardenDataPorts
      })
    );
    const scheduler = currentScheduler();

    await getService(runtime, "Janitor").task();

    // DORMANT_DEMOTION and TERMINAL TOMBSTONE_GC are both enqueued alongside
    // TTL_CLEANUP. TOMBSTONE_GC's destructive sweep is gated (disposition required
    // + >=24h grace + atomic capsule re-verify), so enabling it is safe.
    expect(scheduler.queue.some((task) => task.task_kind === GardenTaskKind.DORMANT_DEMOTION)).toBe(true);
    expect(scheduler.queue.some((task) => task.task_kind === GardenTaskKind.TOMBSTONE_GC)).toBe(true);

    await drainScheduler(runtime);

    // The faded+idle memory was flipped to lifecycle_state=dormant (REVERSIBLE).
    expect(findLowActivityActiveMemories).toHaveBeenCalledWith("workspace-1");
    expect(setLifecycleDormant).toHaveBeenCalledWith("memory-faded", expect.any(String));
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.DORMANT_DEMOTION,
        role: GardenRole.JANITOR,
        success: true,
        objects_affected: ["memory-faded"]
      })
    );
  });

  it("records a default-workspace Garden pass when no workspaces exist yet", async () => {
    const healthJournalAppend = vi.fn(async () => undefined);
    const runtime = createGardenRuntime(createRuntimeInput({
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
        gardenDataPorts,
        pathRelationRepo: {
          findActive: vi.fn(async () => []),
        findActiveAll: vi.fn(async () => []),
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
    resetSchedulers();
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

    const findDormantAll = vi.fn(
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
        databaseConnection: createConsolidationCapableConnection(),
        legacyTopologyMutationsEnabled: true,
        pathRelationRepo: {
          findActive: vi.fn(async () => []),
        findActiveAll: vi.fn(async () => []),
          findByAnchors: vi.fn(async () => []),
          findDormantAll
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
    expect(findDormantAll).toHaveBeenCalledWith("workspace-1", expect.any(String));

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

  it.each([
    ["implicit fail-closed default", undefined],
    ["explicit fail-closed setting", false]
  ] as const)("does not enqueue or execute legacy consolidation for the %s", async (_mode, enabled) => {
    const findDormantAll = vi.fn(async (): Promise<readonly Readonly<PathRelation>[]> => []);
    const planCycleSpy = vi.spyOn(ConsolidationPlanner.prototype, "planCycle");
    const runCycleSpy = vi.spyOn(ConsolidationExecutor.prototype, "runCycle");
    const runtime = createGardenRuntime(
      createRuntimeInput({
        databaseConnection: createConsolidationCapableConnection(),
        ...(enabled === undefined ? {} : { legacyTopologyMutationsEnabled: enabled }),
        pathRelationRepo: {
          findActive: vi.fn(async () => []),
        findActiveAll: vi.fn(async () => []),
          findByAnchors: vi.fn(async () => []),
          findDormantAll
        } as unknown as GardenRuntimeInput["pathRelationRepo"]
      })
    );
    const scheduler = currentScheduler();

    await getService(runtime, "Librarian").task();
    expect(scheduler.queue.some((task) => task.task_kind === GardenTaskKind.CONSOLIDATION_CYCLE)).toBe(false);

    // A task may have been persisted before the temporal cutover. It must complete
    // as an explicit defer without invoking the legacy planner or executor.
    scheduler.queue.splice(0, scheduler.queue.length);
    scheduler.queue.push({
      task_id: "stale-consolidation-task",
      task_kind: GardenTaskKind.CONSOLIDATION_CYCLE,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1",
      run_id: null,
      target_object_refs: ["workspace-1"],
      priority: 10,
      created_at: "2026-07-17T00:00:00.000Z"
    });

    await getService(runtime, "GardenScheduler").task();

    expect(findDormantAll).not.toHaveBeenCalled();
    expect(planCycleSpy).not.toHaveBeenCalled();
    expect(runCycleSpy).not.toHaveBeenCalled();
    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_id: "stale-consolidation-task",
        success: true,
        outcome: "skipped",
        audit_entries: ["consolidation_deferred:temporal_assertion_provenance_required"]
      })
    );
  });

  it("fails a consolidation cycle when the durable budget table is missing", async () => {
    const runtime = createGardenRuntime(
      createRuntimeInput({
        legacyTopologyMutationsEnabled: true
      })
    );
    const scheduler = currentScheduler();
    scheduler.queue.push({
      task_id: "missing-budget-table",
      task_kind: GardenTaskKind.CONSOLIDATION_CYCLE,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1",
      run_id: null,
      target_object_refs: ["workspace-1"],
      priority: 10,
      created_at: "2026-07-17T00:00:00.000Z"
    });

    await getService(runtime, "GardenScheduler").task();

    expect(scheduler.completions).toContainEqual(
      expect.objectContaining({
        task_id: "missing-budget-table",
        success: false,
        outcome: "failed",
        audit_entries: ["consolidation_failed:no_durable_budget_table"],
        error_message: "consolidation executor unavailable"
      })
    );
  });
});
