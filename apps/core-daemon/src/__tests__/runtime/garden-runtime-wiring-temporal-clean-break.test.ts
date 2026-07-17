import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteHandoffGapRepo,
  SqliteHealthJournalRepo,
  SqliteMemoryEntryRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";

import type { BackgroundServiceConfig } from "../../background/bootstrap.js";

const hoisted = vi.hoisted(() => {
  const schedulers: FakeGardenScheduler[] = [];
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

    public enqueue(task: GardenTaskDescriptor): void {
      this.queue.push(task);
    }

    public async dispatchNextMatchingTaskKind(
      role: string,
      taskKinds: readonly string[],
      workspaceId?: string
    ): Promise<GardenTaskDescriptor | null> {
      const maxTier = tierOrder[roleTier[role] ?? "tier_0"];
      const index = this.queue.findIndex(
        (task) =>
          taskKinds.includes(task.task_kind) &&
          tierOrder[task.required_tier] <= maxTier &&
          (workspaceId === undefined || task.workspace_id === workspaceId)
      );
      if (index < 0) {
        return null;
      }
      const [task] = this.queue.splice(index, 1);
      return task ?? null;
    }

    public async reportCompletion(result: GardenTaskResult): Promise<void> {
      this.completions.push(result);
    }

    public getBacklogSnapshot() {
      return {
        workspace_id: null,
        observed_at: "2026-07-17T00:00:00.000Z",
        queue_depth_total: this.queue.length,
        queue_depth_by_tier: this.queue.reduce(
          (counts, task) => ({ ...counts, [task.required_tier]: counts[task.required_tier] + 1 }),
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

  return { schedulers, FakeGardenScheduler };
});

vi.mock("@do-soul/alaya-soul", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-soul")>();
  return { ...actual, GardenScheduler: hoisted.FakeGardenScheduler };
});

import { createGardenRuntimeWiring } from "../../runtime/garden-runtime-wiring.js";

function getService(
  runtime: Awaited<ReturnType<typeof createGardenRuntimeWiring>>["gardenRuntime"],
  name: string
): BackgroundServiceConfig {
  const services = (runtime.backgroundManager as unknown as {
    readonly services: readonly BackgroundServiceConfig[];
  }).services;
  const service = services.find((candidate) => candidate.name === name);
  if (service === undefined) {
    throw new Error(`Missing ${name} background service.`);
  }
  return service;
}

describe("Garden production temporal clean break", () => {
  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers TOMBSTONE_GC without exposing autonomous hard delete from production wiring", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      await workspaceRepo.create({
        workspace_id: "workspace-1",
        name: "workspace-1",
        root_path: "/tmp/workspace-1",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });
      const eventLogRepo = new SqliteEventLogRepo(database);
      const runtimeNotifier = {
        notify: async () => undefined,
        notifyEntry: async (_entry: EventLogEntry) => undefined
      };
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });
      const autonomousHardDeleteTombstoned = vi.fn(async () => true);
      const warn = vi.fn();
      const input = {
        database,
        startupSteps: [],
        runtimeNotifier,
        warnLogger: {
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
          fatal: vi.fn()
        },
        eventLogRepo,
        eventPublisher,
        memoryService: {
          autonomousTombstone: vi.fn(async () => undefined),
          autonomousHardDeleteTombstoned,
          demoteActiveToDormantIfActive: vi.fn(async () => ({ status: "skipped" }))
        },
        memoryEntryRepo: new SqliteMemoryEntryRepo(database),
        synthesisCapsuleRepo: { findByWorkspaceId: vi.fn(async () => []) },
        healthJournalRepo: new SqliteHealthJournalRepo(database),
        sqliteHandoffGapRepo: new SqliteHandoffGapRepo(database),
        orphanDetectionEnabled: false,
        orphanRadarRepo: null,
        healthJournalService: { record: vi.fn(async () => undefined) },
        healthIssueGroupRepo: undefined,
        pathGraphSnapshotRepo: new SqlitePathGraphSnapshotRepo(database),
        pathRelationRepo: new SqlitePathRelationRepo(database),
        pathPlasticityWatermarkRepo: new SqlitePathPlasticityWatermarkRepo(database),
        embeddingBackfillHandler: undefined,
        configService: undefined,
        officialGardenProvider: undefined,
        localHeuristicsProvider: undefined,
        signalService: undefined,
        strongRefService: { isProtected: vi.fn(async () => false) },
        workspaceRepo,
        enrichPendingRepo: new SqliteEnrichPendingRepo(database),
        signalRepo: new SqliteSignalRepo(database),
        materializationRouter: undefined,
        edgeAutoProducerService: undefined,
        embeddingRecallService: undefined,
        conflictDetectionService: null,
        edgeProposalService: { sweepExpired: vi.fn(async () => ({ scanned: 0, expired: 0, skipped: 0 })) },
        edgeClassifyQueueRepoHolder: { current: null },
        trustStateRecorder: {
          replayCounterIncrement: vi.fn(),
          markReady: vi.fn()
        },
        gardenBacklogThresholds: {
          warning_queue_depth: 100,
          warning_rearm_depth: 50,
          snapshot_interval_ms: 60_000
        }
      } as unknown as Parameters<typeof createGardenRuntimeWiring>[0];

      const wiring = await createGardenRuntimeWiring(input);
      const scheduler = hoisted.schedulers[0];
      if (scheduler === undefined) {
        throw new Error("Garden scheduler was not constructed.");
      }
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          "garden bootstrap path reconciliation deferred without temporal assertion provenance",
          { workspace_id: "workspace-1" }
        );
      });
      expect((await workspaceRepo.list()).map((workspace) => workspace.workspace_id)).toEqual(["workspace-1"]);
      scheduler.queue.splice(0, scheduler.queue.length);

      await getService(wiring.gardenRuntime, "Janitor").task();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await getService(wiring.gardenRuntime, "GardenScheduler").task();
      }

      expect(autonomousHardDeleteTombstoned).not.toHaveBeenCalled();
      expect(scheduler.completions).toContainEqual(
        expect.objectContaining({
          task_kind: GardenTaskKind.TOMBSTONE_GC,
          success: true,
          audit_entries: expect.arrayContaining([
            "[DEFERRED] tombstone_gc: temporal_assertion_provenance_required"
          ])
        })
      );

      // Garden wiring does not accept a path-plasticity writer. A scheduled
      // residual task must complete as a skip instead of updating a legacy row.
      scheduler.queue.splice(0, scheduler.queue.length);
      await getService(wiring.gardenRuntime, "Librarian").task();
      expect(scheduler.queue.some((task) => task.task_kind === GardenTaskKind.CONSOLIDATION_CYCLE)).toBe(false);
      const pathPlasticityTask = scheduler.queue.find(
        (task) => task.task_kind === GardenTaskKind.PATH_PLASTICITY_UPDATE
      );
      expect(pathPlasticityTask).toBeDefined();
      scheduler.queue.splice(0, scheduler.queue.length);
      scheduler.queue.push(pathPlasticityTask!);

      await getService(wiring.gardenRuntime, "GardenScheduler").task();

      expect(scheduler.completions).toContainEqual(
        expect.objectContaining({
          task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
          success: true,
          audit_entries: [
            "path_plasticity_update: skipped because path plasticity port is not configured"
          ]
        })
      );
    } finally {
      database.close();
    }
  });
});
