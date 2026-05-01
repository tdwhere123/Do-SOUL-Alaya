import { randomUUID } from "node:crypto";
import {
  GardenRole,
  type GardenBacklogThresholds,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  PhaseCEventType,
  parsePhaseCEventPayload,
  type AuditorEventLogPort,
  type AuditorOrphanDetectionPort,
  type EventLogEntry,
  type EventType,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTierValue,
  type HealthJournalRecordPort,
  type OrphanRadar,
  type PathGraphSnapshot
} from "@do-soul/alaya-protocol";
import type {
  EmbeddingBackfillHandler,
  EventPublisher,
  StrongRefService
} from "@do-soul/alaya-core";
import {
  createGardenBackgroundDataPorts,
  type SqliteEventLogRepo,
  type SqliteHandoffGapRepo,
  type SqliteHealthJournalRepo,
  type SqliteOrphanRadarRepo,
  type SqlitePathGraphSnapshotRepo,
  type SqlitePathRelationRepo,
  type SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  Auditor,
  GardenScheduler,
  Janitor,
  Librarian,
  PathGraphSnapshotter,
  reviewPathGraphSnapshotHistory,
  type GardenSchedulerEventLogPort,
  type JanitorControlPlaneCleanupPort,
  type JanitorSchedulerPort,
  type LibrarianSchedulerPort
} from "@do-soul/alaya-soul";
import { findOrphanedMemoriesForWorkspace } from "./orphan-query.js";
import { BackgroundServiceManager } from "./background/bootstrap.js";

type PathGraphSnapshotRecord = Readonly<PathGraphSnapshot>;

const PATH_GRAPH_SNAPSHOT_INTERVAL_MS = 900_000;
const PATH_GRAPH_HISTORY_REVIEW_LIMIT = 2;
const PATH_GRAPH_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface GardenBacklogTelemetryObserver {
  capture(): Promise<void>;
}

export interface GardenBacklogTelemetrySource {
  getBacklogSnapshot(): ReturnType<GardenScheduler["getBacklogSnapshot"]>;
  peekBacklogWarningTransition(): ReturnType<GardenScheduler["peekBacklogWarningTransition"]>;
  peekLastBacklogWarningTransitionId(): ReturnType<GardenScheduler["peekLastBacklogWarningTransitionId"]>;
  acknowledgeBacklogWarningTransition(
    transitionId: number
  ): ReturnType<GardenScheduler["acknowledgeBacklogWarningTransition"]>;
}

export function createGardenRuntime(input: {
  readonly databaseConnection: StorageDatabase["connection"];
  readonly backlogThresholds: GardenBacklogThresholds;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly gardenDataPorts: ReturnType<typeof createGardenBackgroundDataPorts>;
  readonly healthJournalRepo: SqliteHealthJournalRepo;
  readonly handoffGapRepo: SqliteHandoffGapRepo;
  readonly orphanDetectionEnabled: boolean;
  readonly orphanRadarRepo: SqliteOrphanRadarRepo | null;
  readonly pathGraphSnapshotRepo: SqlitePathGraphSnapshotRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly embeddingBackfillHandler?: Pick<EmbeddingBackfillHandler, "handle">;
  readonly strongRefService: StrongRefService;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}): Readonly<{
  readonly backgroundManager: BackgroundServiceManager;
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  runBackgroundPass(): Promise<void>;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}> {
  const schedulerEventLogPort: GardenSchedulerEventLogPort = {
    append: async (entry) => {
      await input.eventPublisher.publish({
        event_type: entry.event_type as EventType,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: "garden-scheduler",
        payload_json: entry.payload,
        revision: 1
      });
    }
  };
  const healthJournalPort: HealthJournalRecordPort = {
    record: async (entry) => {
      void (await input.healthJournalRepo.append(entry));
    }
  };
  const gardenScheduler = new GardenScheduler(
    schedulerEventLogPort,
    {
      backlogWarningThresholds: {
        warning_queue_depth: input.backlogThresholds.warning_queue_depth,
        warning_rearm_depth: input.backlogThresholds.warning_rearm_depth
      }
    },
    healthJournalPort
  );
  let backlogTelemetryObserver: GardenBacklogTelemetryObserver | null = null;
  const pendingEmbeddingBackfillWorkspaces = new Set<string>();
  const pathGraphSnapshotter = new PathGraphSnapshotter({
    pathRelationRepo: input.pathRelationRepo
  });

  const cleanupPort: JanitorControlPlaneCleanupPort = {
    findExpiredObjects: async (workspaceId: string, nowIso: string) =>
      input.handoffGapRepo.findExpiredObjectsByWorkspace(workspaceId, nowIso),
    removeExpiredObjects: async (_workspaceId: string, objectIds: readonly string[]) => {
      for (const id of objectIds) {
        input.handoffGapRepo.deleteById(id);
      }
    }
  };
  const janitorSchedulerPort: JanitorSchedulerPort = {
    reportCompletion: (result) => gardenScheduler.reportCompletion(result)
  };
  const janitor = new Janitor({
    cleanupPort,
    tieringPort: input.gardenDataPorts.tieringPort,
    scheduler: janitorSchedulerPort,
    strongRefProtectionPort: {
      isProtected: async (workspaceId: string, targetEntityType: string, targetEntityId: string) =>
        await input.strongRefService.isProtected(workspaceId, targetEntityType, targetEntityId)
    }
  });

  const orphanRadarRepo = input.orphanRadarRepo;
  const orphanDetectionPort: AuditorOrphanDetectionPort | undefined =
    input.orphanDetectionEnabled && orphanRadarRepo !== null
      ? {
          findOrphanedMemories: async (workspaceId: string) =>
            await findOrphanedMemoriesForWorkspace(input.databaseConnection, workspaceId),
          createOrphanRadarRecord: async (record: Readonly<OrphanRadar>) => {
            await orphanRadarRepo.create(record);
          }
        }
      : undefined;
  const auditorEventLogPort: AuditorEventLogPort = {
    append: async (entry) =>
      (await input.eventPublisher.publish({
        ...entry,
        event_type: entry.event_type as EventType
      })) as EventLogEntry
  };
  const auditorSchedulerPort = {
    reportCompletion: (
      result: Parameters<GardenScheduler["reportCompletion"]>[0]
    ) => gardenScheduler.reportCompletion(result)
  };
  const auditor = new Auditor({
    evidenceCheckPort: input.gardenDataPorts.evidenceCheckPort,
    pointerHealthPort: input.gardenDataPorts.pointerHealthPort,
    greenMaintenancePort: input.gardenDataPorts.greenMaintenancePort,
    bootstrappingPort: input.gardenDataPorts.bootstrappingPort,
    orphanDetectionPort,
    scheduler: auditorSchedulerPort,
    healthJournal: healthJournalPort,
    eventLogRepo: auditorEventLogPort
  });

  const librarianSchedulerPort: LibrarianSchedulerPort = {
    reportCompletion: (result) => gardenScheduler.reportCompletion(result)
  };
  const librarian = new Librarian({
    mergePort: input.gardenDataPorts.mergePort,
    neighborPort: input.gardenDataPorts.neighborPort,
    compressionPort: input.gardenDataPorts.compressionPort,
    synthesisPort: input.gardenDataPorts.synthesisPort,
    scheduler: librarianSchedulerPort,
    healthJournal: healthJournalPort
  });
  const backlogTelemetrySource = {
    getBacklogSnapshot: () => gardenScheduler.getBacklogSnapshot(),
    peekBacklogWarningTransition: () => gardenScheduler.peekBacklogWarningTransition(),
    peekLastBacklogWarningTransitionId: () => gardenScheduler.peekLastBacklogWarningTransitionId(),
    acknowledgeBacklogWarningTransition: (transitionId: number) =>
      gardenScheduler.acknowledgeBacklogWarningTransition(transitionId)
  };

  const requestBacklogTelemetryCapture = (reason: string): void => {
    const observer = backlogTelemetryObserver;
    if (observer === null) {
      return;
    }

    void observer
      .capture()
      .catch((error) => {
        console.warn("[garden] backlog telemetry observer capture failed", {
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  };

  const enqueueForAllWorkspaces = async (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs: (workspaceId: string) => readonly string[] = () => []
  ): Promise<void> => {
    const workspaces = await input.workspaceRepo.list();
    const nowIso = new Date().toISOString();
    for (const workspace of workspaces) {
      gardenScheduler.enqueue({
        task_id: randomUUID(),
        task_kind: taskKind,
        required_tier: requiredTier,
        workspace_id: workspace.workspace_id,
        run_id: null,
        target_object_refs: resolveTargetObjectRefs(workspace.workspace_id),
        priority: 10,
        created_at: nowIso
      });
    }

    if (workspaces.length > 0) {
      requestBacklogTelemetryCapture(`enqueue:${taskKind}`);
    }
  };

  const enqueueEmbeddingBackfillForAllWorkspaces = async (): Promise<void> => {
    const workspaces = await input.workspaceRepo.list();
    const nowIso = new Date().toISOString();
    let enqueuedCount = 0;

    for (const workspace of workspaces) {
      if (pendingEmbeddingBackfillWorkspaces.has(workspace.workspace_id)) {
        continue;
      }

      pendingEmbeddingBackfillWorkspaces.add(workspace.workspace_id);
      gardenScheduler.enqueue({
        task_id: randomUUID(),
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        required_tier: GardenTier.TIER_2,
        workspace_id: workspace.workspace_id,
        run_id: null,
        target_object_refs: [workspace.workspace_id],
        priority: 10,
        created_at: nowIso
      });
      enqueuedCount += 1;
    }

    if (enqueuedCount > 0) {
      requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);
    }
  };

  const persistPathGraphSnapshotForWorkspace = async (
    workspaceId: string,
    previousSnapshot: PathGraphSnapshotRecord | null
  ): Promise<PathGraphSnapshotRecord> => {
    const snapshot = await pathGraphSnapshotter.buildSnapshot(workspaceId, previousSnapshot);

    await input.eventPublisher.publishWithMutation(
      {
        event_type: PhaseCEventType.PATH_GRAPH_SNAPSHOT_CREATED,
        entity_type: "path_graph_snapshot",
        entity_id: snapshot.snapshot_id,
        workspace_id: workspaceId,
        run_id: null,
        caused_by: "garden-path-graph-snapshotter",
        payload_json: parsePhaseCEventPayload(PhaseCEventType.PATH_GRAPH_SNAPSHOT_CREATED, {
          snapshot_id: snapshot.snapshot_id,
          workspace_id: snapshot.workspace_id,
          total_active_paths: snapshot.total_active_paths,
          total_retired_paths: snapshot.total_retired_paths,
          snapshot_at: snapshot.snapshot_at
        }),
        revision: 1
      },
      async () => {
        await input.pathGraphSnapshotRepo.create(snapshot);
      }
    );

    return snapshot;
  };

  const reviewPathGraphHistoryForWorkspace = async (workspaceId: string): Promise<void> => {
    const history = await input.pathGraphSnapshotRepo.findHistory(
      workspaceId,
      PATH_GRAPH_HISTORY_REVIEW_LIMIT
    );
    const review = reviewPathGraphSnapshotHistory(workspaceId, history);

    if (review === null) {
      return;
    }

    await healthJournalPort.record({
      event_kind: HealthEventKind.GARDEN_BACKLOG,
      workspace_id: workspaceId,
      run_id: null,
      summary: review.summary,
      detail_json: review.detail_json
    });
  };

  const prunePathGraphHistoryForWorkspace = async (
    workspaceId: string,
    snapshotAt: string
  ): Promise<void> => {
    const snapshotAtMs = Date.parse(snapshotAt);
    if (!Number.isFinite(snapshotAtMs)) {
      return;
    }

    await input.pathGraphSnapshotRepo.deleteOlderThan(
      workspaceId,
      new Date(snapshotAtMs - PATH_GRAPH_SNAPSHOT_RETENTION_MS).toISOString()
    );
  };

  const runPathGraphSnapshotTask = async (task: Readonly<GardenTaskDescriptor>): Promise<void> => {
    const completedAt = new Date().toISOString();

    try {
      const previousSnapshot = await input.pathGraphSnapshotRepo.findLatest(task.workspace_id);
      const snapshot = isPathGraphSnapshotDue(previousSnapshot, Date.now())
        ? await persistPathGraphSnapshotForWorkspace(task.workspace_id, previousSnapshot)
        : null;

      if (snapshot !== null) {
        await prunePathGraphHistoryForWorkspace(task.workspace_id, snapshot.snapshot_at).catch((error) => {
          console.warn("[garden] path graph snapshot prune failed after persistence", {
            workspaceId: task.workspace_id,
            snapshotId: snapshot.snapshot_id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        await reviewPathGraphHistoryForWorkspace(task.workspace_id);
      }

      await gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: true,
        objects_affected: snapshot === null ? [] : [snapshot.snapshot_id],
        audit_entries: snapshot === null ? ["snapshot_skipped:not_due"] : [snapshot.snapshot_id],
        error_message: null,
        completed_at: completedAt
      });
    } catch (error) {
      await gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: false,
        objects_affected: [],
        audit_entries: [],
        error_message: error instanceof Error ? error.message : String(error),
        completed_at: completedAt
      });

      throw error;
    }
  };

  const runEmbeddingBackfillTask = async (task: Readonly<GardenTaskDescriptor>): Promise<void> => {
    const completedAt = new Date().toISOString();

    try {
      const result =
        input.embeddingBackfillHandler === undefined
          ? {
              objectsAffected: [] as readonly string[],
              auditEntries: ["embedding_backfill_skipped:handler_unconfigured"] as readonly string[]
            }
          : await input.embeddingBackfillHandler.handle(task);

      await gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: true,
        objects_affected: [...result.objectsAffected],
        audit_entries: [...result.auditEntries],
        error_message: null,
        completed_at: completedAt
      });
    } catch (error) {
      await gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: false,
        objects_affected: [],
        audit_entries: [],
        error_message: error instanceof Error ? error.message : String(error),
        completed_at: completedAt
      });

      throw error;
    } finally {
      pendingEmbeddingBackfillWorkspaces.delete(task.workspace_id);
    }
  };

  const backgroundServices = [
    {
      name: "Janitor",
      intervalMs: 300_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.TTL_CLEANUP, GardenTier.TIER_0);
      }
    },
    {
      name: "Auditor",
      intervalMs: 1_800_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.EVIDENCE_STALENESS_CHECK, GardenTier.TIER_1);
        if (input.orphanDetectionEnabled) {
          await enqueueForAllWorkspaces(GardenTaskKind.ORPHAN_DETECTION, GardenTier.TIER_1);
        }
      }
    },
    {
      name: "Librarian",
      intervalMs: 900_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.MERGE_PROPOSAL, GardenTier.TIER_2);
        if (input.embeddingBackfillHandler !== undefined) {
          await enqueueEmbeddingBackfillForAllWorkspaces();
        }
        await enqueueForAllWorkspaces(
          GardenTaskKind.PATH_GRAPH_SNAPSHOT,
          GardenTier.TIER_2,
          (workspaceId) => [workspaceId]
        );
      }
    },
    {
      name: "GardenScheduler",
      intervalMs: 60_000,
      task: async () => {
        for (const [role, handler] of [
          ["janitor", janitor],
          ["auditor", auditor],
          ["librarian", librarian]
        ] as const) {
          const task = await gardenScheduler.dispatchNext(role);
          requestBacklogTelemetryCapture(`dispatch:${role}`);
          if (task === null) {
            continue;
          }

          if (task.task_kind === GardenTaskKind.PATH_GRAPH_SNAPSHOT) {
            await runPathGraphSnapshotTask(task);
            continue;
          }

          if (task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL) {
            await runEmbeddingBackfillTask(task);
            continue;
          }

          await handler.run(task);
        }
      }
    }
  ];
  const backgroundManager = new BackgroundServiceManager(backgroundServices);

  return Object.freeze({
    backgroundManager,
    backlogTelemetrySource,
    runBackgroundPass: async () => {
      for (const service of backgroundServices) {
        await service.task();
      }
      const workspaces = await input.workspaceRepo.list();
      for (const workspace of workspaces) {
        await healthJournalPort.record({
          event_kind: HealthEventKind.GARDEN_BACKLOG,
          workspace_id: workspace.workspace_id,
          run_id: null,
          summary: "Garden background pass completed",
          detail_json: {
            service_count: backgroundServices.length,
            services: backgroundServices.map((service) => service.name)
          }
        });
      }
    },
    setBacklogTelemetryObserver: (observer: GardenBacklogTelemetryObserver | null) => {
      backlogTelemetryObserver = observer;
    }
  });
}

function isPathGraphSnapshotDue(
  snapshot: PathGraphSnapshotRecord | null,
  nowMs: number
): boolean {
  if (snapshot === null) {
    return true;
  }

  const snapshotAtMs = Date.parse(snapshot.snapshot_at);
  if (!Number.isFinite(snapshotAtMs)) {
    return true;
  }

  return nowMs - snapshotAtMs >= PATH_GRAPH_SNAPSHOT_INTERVAL_MS;
}
