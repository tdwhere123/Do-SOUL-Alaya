import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  PhaseCExtensionEventType,
  WorkspaceKind,
  type GardenBacklogSnapshot,
  type HealthJournalRecordInput
} from "@do-what/protocol";
import {
  GardenBacklogTelemetryService,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteHealthJournalRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-what/storage";
import { GardenScheduler } from "@do-what/soul";
import { createApp } from "../app.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSurfaceService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

describe("garden backlog routes", () => {
  it("returns the current live backlog snapshot", async () => {
    const snapshot = createSnapshot();
    const getSnapshot = vi.fn(() => snapshot);
    const { app } = createTestContext({
      gardenBacklogTelemetryService: {
        getSnapshot
      }
    });
    await createWorkspace(app, "garden-backlog-route");

    const response = await app.request("/garden/backlog");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: snapshot
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("wires scheduler state through telemetry service into the daemon route", async () => {
    const database = initDatabase({ filename: ":memory:" });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const healthJournalRepo = new SqliteHealthJournalRepo(database);
    const schedulerEventLog = {
      append: vi.fn(async () => undefined)
    };
    const scheduler = new GardenScheduler(schedulerEventLog, {
      now: () => "2026-04-23T08:15:00.000Z",
      backlogWarningThresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1
      }
    });
    const telemetryService = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal: {
        record: async (entry: HealthJournalRecordInput) => {
          await healthJournalRepo.append(entry);
        }
      },
      thresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1,
        snapshot_interval_ms: 60_000
      }
    });
    const { app } = createTestContext({
      gardenBacklogTelemetryService: telemetryService
    });

    scheduler.enqueue(
      createSchedulerTask({
        task_id: "task-tier-0",
        required_tier: GardenTier.TIER_0
      })
    );
    scheduler.enqueue(
      createSchedulerTask({
        task_id: "task-tier-1",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    await expect(telemetryService.capture()).resolves.toBeUndefined();

    const response = await app.request("/garden/backlog");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: null,
        observed_at: "2026-04-23T08:15:00.000Z",
        queue_depth_total: 2,
        queue_depth_by_tier: {
          tier_0: 1,
          tier_1: 1,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: true
      }
    });

    await expect(eventLogRepo.queryByEntity("garden_backlog", "global")).resolves.toEqual([
      expect.objectContaining({
        event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
        workspace_id: "system",
        run_id: null,
        payload_json: {
          workspace_id: "system",
          observed_at: "2026-04-23T08:15:00.000Z",
          queue_depth_total: 2,
          queue_depth_by_tier: {
            tier_0: 1,
            tier_1: 1,
            tier_2: 0
          },
          in_flight_total: 0,
          warning_active: true,
          run_id: null,
          warning_queue_depth: 1,
          warning_rearm_depth: 1,
          transition: "arm"
        }
      })
    ]);
    await expect(
      healthJournalRepo.findByWorkspace("system", {
        kind: HealthEventKind.GARDEN_BACKLOG
      })
    ).resolves.toEqual([
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: "system",
        run_id: null,
        detail_json: {
          workspace_id: "system",
          observed_at: "2026-04-23T08:15:00.000Z",
          queue_depth_total: 2,
          queue_depth_by_tier: {
            tier_0: 1,
            tier_1: 1,
            tier_2: 0
          },
          in_flight_total: 0,
          warning_active: true,
          run_id: null,
          warning_queue_depth: 1,
          warning_rearm_depth: 1,
          transition: "arm"
        }
      })
    ]);
  });

  it("keeps the route snapshot stable and suppresses stale clear publication when dispatch append fails", async () => {
    const database = initDatabase({ filename: ":memory:" });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const healthJournalRepo = new SqliteHealthJournalRepo(database);
    const schedulerEventLog = {
      append: vi
        .fn(async () => undefined)
        .mockRejectedValueOnce(new Error("dispatch append failed"))
    };
    const scheduler = new GardenScheduler(schedulerEventLog, {
      now: () => "2026-04-23T08:15:00.000Z",
      backlogWarningThresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1
      }
    });
    const telemetryService = new GardenBacklogTelemetryService({
      scheduler,
      eventLogRepo,
      healthJournal: {
        record: async (entry: HealthJournalRecordInput) => {
          await healthJournalRepo.append(entry);
        }
      },
      thresholds: {
        warning_queue_depth: 1,
        warning_rearm_depth: 1,
        snapshot_interval_ms: 60_000
      }
    });
    const { app } = createTestContext({
      gardenBacklogTelemetryService: telemetryService
    });

    scheduler.enqueue(
      createSchedulerTask({
        task_id: "task-a",
        required_tier: GardenTier.TIER_0
      })
    );
    scheduler.enqueue(
      createSchedulerTask({
        task_id: "task-b",
        task_kind: GardenTaskKind.GREEN_MAINTENANCE,
        required_tier: GardenTier.TIER_1
      })
    );

    await expect(telemetryService.capture()).resolves.toBeUndefined();

    await expect(scheduler.dispatchNext(GardenRole.LIBRARIAN)).rejects.toThrow("dispatch append failed");

    const response = await app.request("/garden/backlog");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: null,
        observed_at: "2026-04-23T08:15:00.000Z",
        queue_depth_total: 2,
        queue_depth_by_tier: {
          tier_0: 1,
          tier_1: 1,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: true
      }
    });

    schedulerEventLog.append.mockResolvedValueOnce(undefined);
    await expect(telemetryService.capture()).resolves.toBeUndefined();

    await expect(eventLogRepo.queryByEntity("garden_backlog", "global")).resolves.toEqual([
      expect.objectContaining({
        event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING,
        payload_json: expect.objectContaining({
          transition: "arm",
          queue_depth_total: 2
        })
      })
    ]);
  });
});

function createTestContext(options: {
  readonly gardenBacklogTelemetryService?: {
    getSnapshot(): GardenBacklogSnapshot;
  };
} = {}) {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService: createNoopConversationService("garden backlog route tests") as never,
      engineBindingService: createStubEngineBindingService() as never,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("garden backlog route tests") as never,
      evidenceService: createUnusedEvidenceService("garden backlog route tests") as never,
      memoryService: createUnusedMemoryService("garden backlog route tests") as never,
      slotService: createUnusedSlotService("garden backlog route tests") as never,
      surfaceService: createUnusedSurfaceService("garden backlog route tests") as never,
      synthesisService: createUnusedSynthesisService("garden backlog route tests") as never,
      claimService: createUnusedClaimService("garden backlog route tests") as never,
      proposalService: createUnusedProposalService("garden backlog route tests") as never,
      gardenBacklogTelemetryService: options.gardenBacklogTelemetryService
    })
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = await response.json();
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
  return workspace;
}

function createSnapshot(overrides: Partial<GardenBacklogSnapshot> = {}): GardenBacklogSnapshot {
  return {
    workspace_id: null,
    observed_at: "2026-04-23T08:00:00.000Z",
    queue_depth_total: 5,
    queue_depth_by_tier: {
      tier_0: 1,
      tier_1: 2,
      tier_2: 2
    },
    in_flight_total: 0,
    warning_active: false,
    ...overrides
  };
}

function createSchedulerTask(overrides: {
  readonly task_id: string;
  readonly task_kind?: GardenTaskKind;
  readonly required_tier: GardenTier;
}) {
  return {
    task_id: overrides.task_id,
    task_kind: overrides.task_kind ?? GardenTaskKind.TTL_CLEANUP,
    required_tier: overrides.required_tier,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-04-23T08:15:00.000Z"
  };
}
