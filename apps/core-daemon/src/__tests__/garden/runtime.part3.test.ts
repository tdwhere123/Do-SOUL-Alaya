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
});
