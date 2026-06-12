import { randomUUID } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  RuntimeGovernanceEventType,
  isPathActiveForRecall,
  parseRuntimeGovernanceEventPayload,
  type EventType,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTierValue,
  type PathGraphSnapshot,
  type SoulConfig
} from "@do-soul/alaya-protocol";
import type { EmbeddingBackfillHandler, EventPublisher } from "@do-soul/alaya-core";
import {
  AuditorSchedulingAdvisor as CoreAuditorSchedulingAdvisor,
  ConsolidationExecutor,
  ConsolidationPlanner,
  createVerificationBiasReaderFromPathLookup,
  isEmbeddingBackfillPartialFailureError,
  type AuditorSchedulingAdvisor
} from "@do-soul/alaya-core";
import type {
  PathPlasticityWatermarkRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  PathGraphSnapshotter,
  reviewPathGraphSnapshotHistory
} from "@do-soul/alaya-soul";
import {
  createPathPlasticityWatermarkRegistry,
  type PathPlasticityWatermarkRegistry
} from "./path-plasticity-runtime.js";

type PathGraphSnapshotRecord = Readonly<PathGraphSnapshot>;
type EmbeddingBackfillTaskOutcome = Readonly<{
  readonly success: boolean;
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
  readonly errorMessage: string | null;
}>;
type RuntimeGardenScheduler = {
  dispatchNextMatchingTaskKind(
    role: string,
    taskKinds: readonly GardenTaskKindValue[],
    workspaceId?: string
  ): Promise<Readonly<GardenTaskDescriptor> | null>;
};

const PATH_GRAPH_SNAPSHOT_INTERVAL_MS = 900_000;
const PATH_GRAPH_HISTORY_REVIEW_LIMIT = 2;
const PATH_GRAPH_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS = 8;
const EDGE_PROPOSAL_RECONCILE_CAP_PER_PASS = 32;
const EDGE_PROPOSAL_EXPIRY_CAP_PER_PASS = 64;

export interface GardenSchedulerRuntimeSupport {
  readonly auditorSchedulingAdvisor: AuditorSchedulingAdvisor;
  markPathPlasticityProcessed(params: {
    readonly workspaceId: string;
    readonly processedThroughIso: string;
    readonly processedAuditEventId?: string | null;
  }): void;
  readonly pathPlasticityPendingPort: {
    clearPendingWorkspace(workspaceId: string): void;
  };
  enqueueEmbeddingBackfillForAllWorkspaces(): Promise<void>;
  enqueuePathPlasticityForAllWorkspaces(): Promise<void>;
  runPathGraphSnapshotTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  runEmbeddingBackfillTask(task: Readonly<GardenTaskDescriptor>): Promise<EmbeddingBackfillTaskOutcome>;
  runConsolidationCycleTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
  reconcileStuckEdgeProposalAccepts(): Promise<void>;
  sweepExpiredEdgeProposals(): Promise<void>;
  runEventLogOrphanDetection(): Promise<void>;
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
}

export function createGardenSchedulerRuntimeSupport(input: Readonly<{
  readonly coherenceEdgeProducerPort?: {
    crystallizeForBackfill(input: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly objectIds: readonly string[];
    }): Promise<unknown>;
  };
  readonly configService?: {
    getSoulConfig?(workspaceId: string): Promise<SoulConfig>;
  };
  readonly consolidationExecutor: ConsolidationExecutor | null;
  readonly embeddingBackfillHandler?: Pick<EmbeddingBackfillHandler, "handle">;
  readonly edgeProposalReconcile?: {
    reconcileStuckAccepts(input: {
      readonly workspaceId: string;
      readonly limit: number;
    }): Promise<Readonly<{
      readonly scanned: number;
      readonly reminted: number;
      readonly already_present: number;
      readonly rejected: number;
      readonly transient_failed: number;
    }>>;
    sweepExpired(input: {
      readonly workspaceId: string;
      readonly limit: number;
    }): Promise<Readonly<{
      readonly scanned: number;
      readonly expired: number;
      readonly skipped: number;
    }>>;
  };
  readonly enqueueForAllWorkspaces?: (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs?: (workspaceId: string, nowIso: string) => readonly string[]
  ) => Promise<void>;
  readonly eventPublisher: Pick<EventPublisher, "publish" | "appendManyWithMutation">;
  readonly gardenScheduler: {
    enqueue(task: {
      readonly task_id: string;
      readonly task_kind: string;
      readonly required_tier: string;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_refs: readonly string[];
      readonly priority: number;
      readonly created_at: string;
    }): void;
    reportCompletion(task: {
      readonly task_id: string;
      readonly task_kind: string;
      readonly role: string;
      readonly tier: string;
      readonly workspace_id: string;
      readonly success: boolean;
      readonly objects_affected: readonly string[];
      readonly audit_entries: readonly string[];
      readonly error_message: string | null;
      readonly completed_at: string;
    }): Promise<void>;
  };
  readonly healthJournalPort: {
    record(entry: {
      readonly event_kind: string;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly summary: string;
      readonly detail_json: unknown;
    }): Promise<void>;
  };
  readonly pathGraphSnapshotRepo: SqlitePathGraphSnapshotRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly pathPlasticityWatermarkRepo?: PathPlasticityWatermarkRepo;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
  readonly runtimeGardenScheduler: RuntimeGardenScheduler;
  readonly runAuditorTask?: (task: Readonly<GardenTaskDescriptor>) => Promise<void>;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}>): GardenSchedulerRuntimeSupport {
  const pendingEmbeddingBackfillWorkspaces = new Set<string>();
  const pendingPathPlasticityWorkspaces = new Set<string>();
  const pathPlasticityWatermark: PathPlasticityWatermarkRegistry =
    createPathPlasticityWatermarkRegistry({
      ...(input.pathPlasticityWatermarkRepo === undefined
        ? {}
        : { watermarkRepo: input.pathPlasticityWatermarkRepo })
    });
  const pathGraphSnapshotter = new PathGraphSnapshotter({
    pathRelationRepo: input.pathRelationRepo
  });

  const auditorSchedulingAdvisor: AuditorSchedulingAdvisor = new CoreAuditorSchedulingAdvisor({
    verificationBiasReader: createVerificationBiasReaderFromPathLookup({
      findActiveByAnchorObjectIds: async (workspaceId, memoryObjectIds) => {
        if (memoryObjectIds.length === 0) {
          return [];
        }
        const anchors = memoryObjectIds.map((objectId) => ({
          kind: "object" as const,
          object_id: objectId
        }));
        const paths = await input.pathRelationRepo.findByAnchors(workspaceId, anchors);
        return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
      }
    })
  });

  const pathPlasticityPendingPort = {
    clearPendingWorkspace(workspaceId: string): void {
      pendingPathPlasticityWorkspaces.delete(workspaceId);
    }
  };
  const markPathPlasticityProcessed = (params: {
    readonly workspaceId: string;
    readonly processedThroughIso: string;
    readonly processedAuditEventId?: string | null;
  }): void => {
    pathPlasticityWatermark.markProcessed(
      params.workspaceId,
      params.processedThroughIso,
      params.processedAuditEventId ?? null,
      new Date().toISOString()
    );
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
      input.gardenScheduler.enqueue({
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
      input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);
    }
  };

  const enqueuePathPlasticityForAllWorkspaces = async (): Promise<void> => {
    const workspaces = await input.workspaceRepo.list();
    const nowIso = new Date().toISOString();
    let enqueuedCount = 0;

    for (const workspace of workspaces) {
      if (pendingPathPlasticityWorkspaces.has(workspace.workspace_id)) {
        continue;
      }

      const targetObjectRefs = [
        pathPlasticityWatermark.getSince(workspace.workspace_id, nowIso),
        nowIso
      ];
      pendingPathPlasticityWorkspaces.add(workspace.workspace_id);
      try {
        input.gardenScheduler.enqueue({
          task_id: randomUUID(),
          task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
          required_tier: GardenTier.TIER_2,
          workspace_id: workspace.workspace_id,
          run_id: null,
          target_object_refs: targetObjectRefs,
          priority: 10,
          created_at: nowIso
        });
        enqueuedCount += 1;
      } catch (error) {
        pendingPathPlasticityWorkspaces.delete(workspace.workspace_id);
        throw error;
      }
    }

    if (enqueuedCount > 0) {
      input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.PATH_PLASTICITY_UPDATE}`);
    }
  };

  const persistPathGraphSnapshotForWorkspace = async (
    workspaceId: string,
    previousSnapshot: PathGraphSnapshotRecord | null
  ): Promise<PathGraphSnapshotRecord> => {
    const snapshot = await pathGraphSnapshotter.buildSnapshot(workspaceId, previousSnapshot);
    await input.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED as EventType,
          entity_type: "path_graph_snapshot",
          entity_id: snapshot.snapshot_id,
          workspace_id: workspaceId,
          run_id: null,
          caused_by: "garden-path-graph-snapshotter",
          payload_json: parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED, {
            snapshot_id: snapshot.snapshot_id,
            workspace_id: snapshot.workspace_id,
            total_active_paths: snapshot.total_active_paths,
            snapshot_at: snapshot.snapshot_at
          })
        }
      ],
      () => {
        input.pathGraphSnapshotRepo.create(snapshot);
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
    await input.healthJournalPort.record({
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
          input.warn("garden path graph snapshot prune failed after persistence", {
            workspaceId: task.workspace_id,
            snapshotId: snapshot.snapshot_id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        await reviewPathGraphHistoryForWorkspace(task.workspace_id);
      }

      await input.gardenScheduler.reportCompletion({
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
      await input.gardenScheduler.reportCompletion({
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

  const runEmbeddingBackfillTask = async (
    task: Readonly<GardenTaskDescriptor>
  ): Promise<EmbeddingBackfillTaskOutcome> => {
    const completedAt = new Date().toISOString();
    try {
      const result =
        input.embeddingBackfillHandler === undefined
          ? {
              objectsAffected: [] as readonly string[],
              auditEntries: ["embedding_backfill_skipped:handler_unconfigured"] as readonly string[]
            }
          : await input.embeddingBackfillHandler.handle(task);

      if (input.coherenceEdgeProducerPort !== undefined && result.objectsAffected.length >= 2) {
        try {
          await input.coherenceEdgeProducerPort.crystallizeForBackfill({
            workspaceId: task.workspace_id,
            runId: null,
            objectIds: result.objectsAffected
          });
        } catch (coherenceError) {
          input.warn("coherence crystallization failed after embedding backfill", {
            workspace_id: task.workspace_id,
            error: coherenceError instanceof Error ? coherenceError.message : String(coherenceError)
          });
        }
      }

      await input.gardenScheduler.reportCompletion({
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
      return Object.freeze({
        success: true,
        objectsAffected: Object.freeze([...result.objectsAffected]),
        auditEntries: Object.freeze([...result.auditEntries]),
        errorMessage: null
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const objectsAffected = isEmbeddingBackfillPartialFailureError(error) ? error.objectsAffected : [];
      const auditEntries = isEmbeddingBackfillPartialFailureError(error) ? error.auditEntries : [];
      await input.gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: false,
        objects_affected: [...objectsAffected],
        audit_entries: [...auditEntries],
        error_message: errorMessage,
        completed_at: completedAt
      });
      input.warn("embedding backfill task failed; continuing Garden background pass", {
        workspace_id: task.workspace_id,
        error: errorMessage
      });
      return Object.freeze({
        success: false,
        objectsAffected: Object.freeze([...objectsAffected]),
        auditEntries: Object.freeze([...auditEntries]),
        errorMessage
      });
    } finally {
      pendingEmbeddingBackfillWorkspaces.delete(task.workspace_id);
    }
  };

  const summarizeEmbeddingBackfillTargetedReason = (
    outcome: EmbeddingBackfillTaskOutcome
  ): string | null => {
    if (!outcome.success) {
      return outcome.errorMessage;
    }
    const failedEntries = outcome.auditEntries.filter(
      (entry) =>
        entry.startsWith("embedding_backfill_skipped:") ||
        entry.startsWith("embedding_failed:provider:") ||
        entry.startsWith("embedding_failed:persistence:")
    );
    if (failedEntries.length === 0) {
      return null;
    }
    return failedEntries.length === 1
      ? failedEntries[0]!
      : `${failedEntries[0]!} (+${failedEntries.length - 1} more)`;
  };

  const runConsolidationCycleTask = async (task: Readonly<GardenTaskDescriptor>): Promise<void> => {
    const completedAt = new Date().toISOString();
    try {
      if (input.consolidationExecutor === null) {
        await reportConsolidationCycleCompletion(task, completedAt, true, [
          "consolidation_skipped:no_durable_budget_table"
        ]);
        return;
      }
      const soulConfig = await input.configService?.getSoulConfig?.(task.workspace_id);
      if (soulConfig !== undefined && !soulConfig.memory_consolidation_enabled) {
        await reportConsolidationCycleCompletion(task, completedAt, true, [
          "consolidation_skipped:memory_consolidation_disabled"
        ]);
        return;
      }

      const planner = new ConsolidationPlanner({
        pathRelationRepo: input.pathRelationRepo,
        now: () => completedAt
      });
      const plan = await planner.planCycle(task.workspace_id);
      const result = await input.consolidationExecutor.runCycle({
        triggerSource: "native_surface_drift",
        plan
      });
      await reportConsolidationCycleCompletion(task, completedAt, true, [
        `consolidation_cycle:fuse_${result.fuse_outcome}`
      ]);
    } catch (error) {
      await reportConsolidationCycleCompletion(task, completedAt, false, [], error);
      input.warn("consolidation cycle task failed; continuing Garden background pass", {
        workspace_id: task.workspace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const reportConsolidationCycleCompletion = async (
    task: Readonly<GardenTaskDescriptor>,
    completedAt: string,
    success: boolean,
    auditEntries: readonly string[],
    error?: unknown
  ): Promise<void> => {
    await input.gardenScheduler.reportCompletion({
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: task.workspace_id,
      success,
      objects_affected: [],
      audit_entries: [...auditEntries],
      error_message: success ? null : error instanceof Error ? error.message : String(error),
      completed_at: completedAt
    });
  };

  const reconcileStuckEdgeProposalAccepts = async (): Promise<void> => {
    const edgeProposalReconcile = input.edgeProposalReconcile;
    if (edgeProposalReconcile === undefined) {
      return;
    }
    const workspaces = await input.workspaceRepo.list();
    for (const workspace of workspaces) {
      try {
        const result = await edgeProposalReconcile.reconcileStuckAccepts({
          workspaceId: workspace.workspace_id,
          limit: EDGE_PROPOSAL_RECONCILE_CAP_PER_PASS
        });
        if (result.scanned > 0) {
          input.warn("edge proposal accept->mint reconcile pass acted on stranded accepts", {
            workspace_id: workspace.workspace_id,
            scanned: result.scanned,
            reminted: result.reminted,
            already_present: result.already_present,
            rejected: result.rejected,
            transient_failed: result.transient_failed
          });
        }
      } catch (error) {
        input.warn("edge proposal accept->mint reconcile pass failed; continuing", {
          workspace_id: workspace.workspace_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const sweepExpiredEdgeProposals = async (): Promise<void> => {
    const edgeProposalReconcile = input.edgeProposalReconcile;
    if (edgeProposalReconcile === undefined) {
      return;
    }
    const workspaces = await input.workspaceRepo.list();
    for (const workspace of workspaces) {
      try {
        const result = await edgeProposalReconcile.sweepExpired({
          workspaceId: workspace.workspace_id,
          limit: EDGE_PROPOSAL_EXPIRY_CAP_PER_PASS
        });
        if (result.expired > 0 || result.skipped > 0) {
          input.warn("edge proposal TTL sweep expired past-TTL pending proposals", {
            workspace_id: workspace.workspace_id,
            scanned: result.scanned,
            expired: result.expired,
            skipped: result.skipped
          });
        }
      } catch (error) {
        input.warn("edge proposal TTL sweep failed; continuing", {
          workspace_id: workspace.workspace_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  const runEventLogOrphanDetection = async (): Promise<void> => {
    if (input.enqueueForAllWorkspaces === undefined || input.runAuditorTask === undefined) {
      return;
    }
    await input.enqueueForAllWorkspaces(
      GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION,
      GardenTier.TIER_1
    );

    while (true) {
      const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
        GardenRole.AUDITOR,
        [GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION]
      );
      input.requestBacklogTelemetryCapture("startup:event_log_orphan_detection");
      if (task === null) {
        break;
      }

      await input.runAuditorTask(task);
    }
  };

  const runEmbeddingBackfillPass = async (workspaceId: string): Promise<void> => {
    if (input.embeddingBackfillHandler === undefined) {
      return;
    }

    let dispatchedCount = 0;
    let lastTargetedReason: string | null = null;

    for (let drained = 0; drained < EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS; drained += 1) {
      const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
        GardenRole.LIBRARIAN,
        [GardenTaskKind.EMBEDDING_BACKFILL],
        workspaceId
      );
      input.requestBacklogTelemetryCapture("warmup:embedding_backfill");
      if (task === null) {
        break;
      }

      dispatchedCount += 1;
      const outcome = await runEmbeddingBackfillTask(task);
      lastTargetedReason = summarizeEmbeddingBackfillTargetedReason(outcome) ?? lastTargetedReason;
    }

    if (dispatchedCount === 0 && !pendingEmbeddingBackfillWorkspaces.has(workspaceId)) {
      pendingEmbeddingBackfillWorkspaces.add(workspaceId);
      input.gardenScheduler.enqueue({
        task_id: randomUUID(),
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        required_tier: GardenTier.TIER_2,
        workspace_id: workspaceId,
        run_id: null,
        target_object_refs: [workspaceId],
        priority: 10,
        created_at: new Date().toISOString()
      });
      input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);

      for (let drained = 0; drained < EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS; drained += 1) {
        const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
          GardenRole.LIBRARIAN,
          [GardenTaskKind.EMBEDDING_BACKFILL],
          workspaceId
        );
        input.requestBacklogTelemetryCapture("warmup:embedding_backfill");
        if (task === null) {
          break;
        }

        dispatchedCount += 1;
        const outcome = await runEmbeddingBackfillTask(task);
        lastTargetedReason = summarizeEmbeddingBackfillTargetedReason(outcome) ?? lastTargetedReason;
      }
    }

    if (lastTargetedReason !== null) {
      throw new Error(lastTargetedReason);
    }
  };

  return {
    auditorSchedulingAdvisor,
    markPathPlasticityProcessed,
    pathPlasticityPendingPort,
    enqueueEmbeddingBackfillForAllWorkspaces,
    enqueuePathPlasticityForAllWorkspaces,
    runPathGraphSnapshotTask,
    runEmbeddingBackfillTask,
    runConsolidationCycleTask,
    reconcileStuckEdgeProposalAccepts,
    sweepExpiredEdgeProposals,
    runEventLogOrphanDetection,
    runEmbeddingBackfillPass
  };
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
