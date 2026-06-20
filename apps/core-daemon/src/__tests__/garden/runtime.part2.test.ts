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

describe("garden runtime path plasticity queue", () => {

  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
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
