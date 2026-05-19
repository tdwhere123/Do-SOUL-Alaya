import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type PathGraphSnapshot
} from "@do-soul/alaya-protocol";
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
      taskKinds: readonly string[]
    ): Promise<GardenTaskDescriptor | null> {
      const roleTierValue = roleTier[role] ?? "tier_0";
      const taskIndex = this.queue.findIndex(
        (task) =>
          taskKinds.includes(task.task_kind) &&
          tierOrder[task.required_tier] <= tierOrder[roleTierValue]
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
      greenMaintenancePort: {
        revokeGreen: vi.fn((memoryId: string) => {
          revokeOrder.push(memoryId);
          return { affected: 1 };
        })
      }
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

function createRuntimeInput(options: {
  readonly computeAndApplyPlasticity: NonNullable<
    GardenRuntimeInput["pathPlasticityService"]
  >["computeAndApplyPlasticity"];
  readonly gardenDataPorts?: GardenRuntimeInput["gardenDataPorts"];
  readonly healthJournalRepo?: GardenRuntimeInput["healthJournalRepo"];
  readonly pathRelationRepo?: GardenRuntimeInput["pathRelationRepo"];
  readonly pathPlasticityWatermarkRepo?: GardenRuntimeInput["pathPlasticityWatermarkRepo"];
  readonly workspaceRepo?: GardenRuntimeInput["workspaceRepo"];
}): GardenRuntimeInput {
  let latestSnapshot: PathGraphSnapshot | null = null;
  const publish = vi.fn(async (entry: Record<string, unknown>) => ({
    event_id: `event-${publish.mock.calls.length + 1}`,
    created_at: "2026-05-05T12:00:00.000Z",
    revision: 1,
    ...entry
  }));

  return {
    databaseConnection: {} as GardenRuntimeInput["databaseConnection"],
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50
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
      computeAndApplyPlasticity: options.computeAndApplyPlasticity
    },
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
