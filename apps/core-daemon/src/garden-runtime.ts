import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  GardenRole,
  type GardenBacklogThresholds,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  RuntimeGovernanceEventType,
  isPathActiveForRecall,
  parseGardenEventPayload,
  parseRuntimeGovernanceEventPayload,
  type AuditorEventLogPort,
  type AuditorOrphanDetectionPort,
  type EventLogEntry,
  type EventType,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTierValue,
  type HealthIssueCauseKindValue,
  type HealthIssueGroup,
  type HealthJournalRecordPort,
  type OrphanRadar,
  type PathGraphSnapshot,
  type RuntimeGardenComputeConfig,
  type CandidateMemorySignal,
  type ConsolidationCyclePlan,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  ConsolidationTriggerBudgetSchema,
  type ConversationMessage,
  type SoulConfig
} from "@do-soul/alaya-protocol";
import type {
  AuditorSchedulingAdvisor,
  ConsolidationBudgetStorePort,
  EmbeddingBackfillHandler,
  EventPublisher,
  PathPlasticityService,
  StrongRefService
} from "@do-soul/alaya-core";
import {
  AuditorSchedulingAdvisor as CoreAuditorSchedulingAdvisor,
  ConsolidationExecutor,
  createVerificationBiasReaderFromPathLookup
} from "@do-soul/alaya-core";
import {
  createGardenBackgroundDataPorts,
  type GardenTaskReclaimInput,
  type PathPlasticityWatermarkRepo,
  type SqliteEventLogRepo,
  SqliteGardenTaskRepo,
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
  type AuditorHealthIssueGroupPort,
  GardenScheduler,
  Janitor,
  Librarian,
  normalizeSchemaGroundedSignal,
  PathGraphSnapshotter,
  reviewPathGraphSnapshotHistory,
  type GardenCompileContext,
  type GardenComputeProvider,
  type GardenSchedulerEventLogPort,
  type JanitorControlPlaneCleanupPort,
  type JanitorSchedulerPort,
  type LibrarianSchedulerPort
} from "@do-soul/alaya-soul";
import { findEventLogOrphansForWorkspace, findOrphanedMemoriesForWorkspace } from "./orphan-query.js";
import { BackgroundServiceManager } from "./background/bootstrap.js";
import { buildGardenTaskSignalId } from "./garden-task-signal-id.js";
import {
  createPathPlasticityWatermarkRegistry,
  type PathPlasticityWatermarkRegistry
} from "./path-plasticity-runtime.js";

type PathGraphSnapshotRecord = Readonly<PathGraphSnapshot>;
type RuntimeGardenScheduler = GardenScheduler & {
  dispatchNextMatchingTaskKind(
    role: Parameters<GardenScheduler["dispatchNext"]>[0],
    taskKinds: readonly GardenTaskKindValue[]
  ): ReturnType<GardenScheduler["dispatchNext"]>;
};

const PATH_GRAPH_SNAPSHOT_INTERVAL_MS = 900_000;
const PATH_GRAPH_HISTORY_REVIEW_LIMIT = 2;
const PATH_GRAPH_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";
const IN_PROCESS_POST_TURN_CLAIMANT = "in-process";
// host_worker mode: an attached CLI agent (Codex / Claude Code) claims via
// MCP and runs sub-agent extraction. If the agent crashes or detaches
// before garden.complete_task, the row stays in `claimed` forever. This
// TTL is the upper bound on how long we wait before reclaiming the row
// back to `pending` so another agent can take it. 10 min balances "long
// enough for a real LLM round-trip" against "short enough that operator
// reconnect doesn't have to wait an hour".
const GARDEN_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;
const JANITOR_RUNTIME_TASK_KINDS = [
  GardenTaskKind.TTL_CLEANUP,
  GardenTaskKind.HOT_INDEX_DEMOTION,
  GardenTaskKind.DORMANT_DEMOTION,
  GardenTaskKind.TOMBSTONE_GC
] as const satisfies readonly GardenTaskKindValue[];
const AUDITOR_RUNTIME_TASK_KINDS = [
  GardenTaskKind.EVIDENCE_STALENESS_CHECK,
  GardenTaskKind.POINTER_HEALTH_CHECK,
  GardenTaskKind.GREEN_MAINTENANCE,
  GardenTaskKind.BOOTSTRAPPING_SCAN,
  GardenTaskKind.CRYSTALLIZATION_SCAN,
  GardenTaskKind.POINTER_HEALING,
  GardenTaskKind.ORPHAN_DETECTION,
  GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION
] as const satisfies readonly GardenTaskKindValue[];
const LIBRARIAN_RUNTIME_TASK_KINDS = [
  GardenTaskKind.MERGE_PROPOSAL,
  GardenTaskKind.PATH_GRAPH_SNAPSHOT,
  GardenTaskKind.SUBJECT_NEIGHBOR_DETECT,
  GardenTaskKind.PATH_COMPRESSION,
  GardenTaskKind.TEMPLATE_CANDIDATE,
  GardenTaskKind.SYNTHESIS_REVIEW,
  GardenTaskKind.EMBEDDING_BACKFILL,
  GardenTaskKind.PATH_PLASTICITY_UPDATE,
  GardenTaskKind.CONSOLIDATION_CYCLE
] as const satisfies readonly GardenTaskKindValue[];

// invariant: the executor charges every consolidation cycle against the
// consolidation_trigger_budgets row for its trigger source (migration 035).
// see also: packages/core/src/consolidation-executor.ts
class SqliteConsolidationBudgetStore implements ConsolidationBudgetStorePort {
  private readonly findStatement;
  private readonly upsertStatement;

  public constructor(connection: { prepare(sql: string): SqlitePreparedStatement }) {
    this.findStatement = connection.prepare(`
      SELECT trigger_id, trigger_source, governance_subject, source_object_ref,
             max_attempts_within_window, attempts_used, cooldown_until
      FROM consolidation_trigger_budgets
      WHERE trigger_source = ?
      ORDER BY cooldown_until DESC
      LIMIT 1
    `);
    this.upsertStatement = connection.prepare(`
      INSERT INTO consolidation_trigger_budgets (
        trigger_id, trigger_source, governance_subject, source_object_ref,
        max_attempts_within_window, attempts_used, cooldown_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trigger_id) DO UPDATE SET
        trigger_source = excluded.trigger_source,
        governance_subject = excluded.governance_subject,
        source_object_ref = excluded.source_object_ref,
        max_attempts_within_window = excluded.max_attempts_within_window,
        attempts_used = excluded.attempts_used,
        cooldown_until = excluded.cooldown_until
    `);
  }

  public async findByTriggerSource(
    triggerSource: ConsolidationTriggerSource
  ): Promise<ConsolidationTriggerBudget | null> {
    const row = this.findStatement.get(triggerSource) as
      | {
          readonly trigger_id: string;
          readonly trigger_source: string;
          readonly governance_subject: string | null;
          readonly source_object_ref: string | null;
          readonly max_attempts_within_window: number;
          readonly attempts_used: number;
          readonly cooldown_until: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return ConsolidationTriggerBudgetSchema.parse({
      trigger_id: row.trigger_id,
      trigger_source: row.trigger_source,
      ...(row.governance_subject === null ? {} : { governance_subject: row.governance_subject }),
      ...(row.source_object_ref === null ? {} : { source_object_ref: row.source_object_ref }),
      max_attempts_within_window: row.max_attempts_within_window,
      attempts_used: row.attempts_used,
      cooldown_until: row.cooldown_until
    });
  }

  public async upsert(budget: ConsolidationTriggerBudget): Promise<void> {
    this.upsertStatement.run(
      budget.trigger_id,
      budget.trigger_source,
      budget.governance_subject ?? null,
      budget.source_object_ref ?? null,
      budget.max_attempts_within_window,
      budget.attempts_used,
      budget.cooldown_until
    );
  }
}

interface SqlitePreparedStatement {
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): unknown;
}

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

export interface GardenRuntimeStatus {
  readonly last_pass_at: string | null;
}

interface PostTurnExtractTaskPayload {
  readonly run_id: string;
  readonly turn_index: number;
  readonly workspace_id: string;
  readonly turn_digest: {
    readonly last_messages: readonly {
      readonly role: string;
      readonly content_excerpt: string;
    }[];
    readonly context_manifest: {
      readonly delivered_object_ids: readonly string[];
    };
  };
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
  // invariant: HealthIssueGroup projection writer. When absent, the
  // auditor's orphan and evidence-failure passes skip the inbox
  // upsert silently. see also: AuditorHealthIssueGroupPort.
  readonly healthIssueGroupRepo?: {
    findByCompositeKey(
      workspaceId: string,
      targetObjectId: string,
      causeKind: HealthIssueCauseKindValue
    ): Readonly<HealthIssueGroup> | null;
    upsert(group: HealthIssueGroup): Readonly<HealthIssueGroup>;
  };
  readonly pathGraphSnapshotRepo: SqlitePathGraphSnapshotRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly pathPlasticityWatermarkRepo?: PathPlasticityWatermarkRepo;
  readonly pathPlasticityService?: Pick<PathPlasticityService, "computeAndApplyPlasticity">;
  readonly embeddingBackfillHandler?: Pick<EmbeddingBackfillHandler, "handle">;
  readonly configService?: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
    getSoulConfig?(workspaceId: string): Promise<SoulConfig>;
  };
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly signalReceiver?: {
    receiveSignal(
      signal: CandidateMemorySignal
    ): Promise<Readonly<{ readonly signal: Readonly<{ readonly signal_id: string }> }>>;
  };
  readonly strongRefService: StrongRefService;
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}): Readonly<{
  readonly backgroundManager: BackgroundServiceManager;
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  getStatus(): GardenRuntimeStatus;
  runEventLogOrphanDetection(): Promise<void>;
  runBackgroundPass(): Promise<void>;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}> {
  const pathPlasticityWatermark: PathPlasticityWatermarkRegistry =
    createPathPlasticityWatermarkRegistry({
      ...(input.pathPlasticityWatermarkRepo === undefined
        ? {}
        : { watermarkRepo: input.pathPlasticityWatermarkRepo })
    });
  const warn = input.warn ?? defaultGardenRuntimeWarn;

  const schedulerEventLogPort: GardenSchedulerEventLogPort = {
    append: async (entry) => {
      await input.eventPublisher.publish({
        event_type: entry.event_type as EventType,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: "garden-scheduler",
        payload_json: entry.payload
      });
    }
  };
  const healthJournalPort: HealthJournalRecordPort = {
    record: async (entry) => {
      void (await input.healthJournalRepo.append(entry));
    }
  };
  const gardenTaskRepo =
    typeof (input.databaseConnection as { readonly prepare?: unknown }).prepare === "function"
      ? new SqliteGardenTaskRepo(input.databaseConnection, input.eventPublisher)
      : undefined;
  const gardenScheduler = new GardenScheduler(
    schedulerEventLogPort,
    {
      backlogWarningThresholds: {
        warning_queue_depth: input.backlogThresholds.warning_queue_depth,
        warning_rearm_depth: input.backlogThresholds.warning_rearm_depth
      }
    },
    healthJournalPort,
    gardenTaskRepo
  );
  const runtimeGardenScheduler = gardenScheduler as RuntimeGardenScheduler;
  let backlogTelemetryObserver: GardenBacklogTelemetryObserver | null = null;
  const pendingEmbeddingBackfillWorkspaces = new Set<string>();
  const pendingPathPlasticityWorkspaces = new Set<string>();
  const pathGraphSnapshotter = new PathGraphSnapshotter({
    pathRelationRepo: input.pathRelationRepo
  });
  // invariant: the budget table (migration 035) is the only authority on
  // consolidation re-entry; the executor refuses cycles whose budget row is
  // exhausted or cooling. A missing prepare() means the in-memory test
  // database — consolidation is then skipped (no durable budget table).
  const consolidationBudgetStore =
    typeof (input.databaseConnection as { readonly prepare?: unknown }).prepare === "function"
      ? new SqliteConsolidationBudgetStore(
          input.databaseConnection as { prepare(sql: string): SqlitePreparedStatement }
        )
      : null;
  const consolidationExecutor =
    consolidationBudgetStore === null
      ? null
      : new ConsolidationExecutor({
          pathRelationRepo: input.pathRelationRepo,
          budgetStore: consolidationBudgetStore,
          eventPublisher: input.eventPublisher
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
  // Hot-index demotion emits SOUL_MEMORY_TIER_CHANGED audit rows alongside the
  // storage_tier UPDATE, so wire the same EventPublisher-backed port the
  // Auditor uses.
  const janitorEventLogPort: AuditorEventLogPort = {
    append: async (entry) =>
      (await input.eventPublisher.publish({
        ...entry,
        event_type: entry.event_type as EventType
      })) as EventLogEntry,
    appendManyWithMutation: async (entries, mutate) =>
      await input.eventPublisher.appendManyWithMutation(
        entries.map((entry) => ({
          ...entry,
          event_type: entry.event_type as EventType
        })),
        mutate
      )
  };
  const janitor = new Janitor({
    cleanupPort,
    tieringPort: input.gardenDataPorts.tieringPort,
    scheduler: janitorSchedulerPort,
    strongRefProtectionPort: {
      isProtected: async (workspaceId: string, targetEntityType: string, targetEntityId: string) =>
        await input.strongRefService.isProtected(workspaceId, targetEntityType, targetEntityId)
    },
    eventLogRepo: janitorEventLogPort
  });

  const orphanRadarRepo = input.orphanRadarRepo;
  const orphanDetectionPort: AuditorOrphanDetectionPort | undefined =
    input.orphanDetectionEnabled && orphanRadarRepo !== null
      ? {
          findOrphanedMemories: async (workspaceId: string) =>
            await findOrphanedMemoriesForWorkspace(input.databaseConnection, workspaceId),
          createOrphanRadarRecord: (record: Readonly<OrphanRadar>) => {
            orphanRadarRepo.create(record);
          },
          findEventLogOrphans: async (workspaceId: string) =>
            await findEventLogOrphansForWorkspace(input.databaseConnection, workspaceId),
          createEventLogOrphanRadarRecord: (record) => {
            orphanRadarRepo.createEventLogOrphan(record);
          }
        }
      : undefined;
  const auditorEventLogPort: AuditorEventLogPort = {
    append: async (entry) =>
      (await input.eventPublisher.publish({
        ...entry,
        event_type: entry.event_type as EventType
      })) as EventLogEntry,
    appendManyWithMutation: async (entries, mutate) =>
      await input.eventPublisher.appendManyWithMutation(
        entries.map((entry) => ({
          ...entry,
          event_type: entry.event_type as EventType
        })),
        mutate
      )
  };
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
  const auditorEvidenceCheckPort = {
    findMemoriesWithStaleEvidence: async (workspaceId: string) => {
      const staleEntries =
        await input.gardenDataPorts.evidenceCheckPort.findMemoriesWithStaleEvidence(workspaceId);
      if (staleEntries.length <= 1) {
        return staleEntries;
      }
      const prioritized = await auditorSchedulingAdvisor.prioritizeRechecksByBias(
        workspaceId,
        staleEntries.map((entry) => ({
          memoryObjectId: entry.memory_entry_id,
          enqueuedAt: "1970-01-01T00:00:00.000Z"
        }))
      );
      const priorityByMemoryId = new Map(
        prioritized.map((entry, index) => [entry.memoryObjectId, index])
      );
      return Object.freeze(
        [...staleEntries].sort((left, right) => {
          const leftRank = priorityByMemoryId.get(left.memory_entry_id) ?? Number.MAX_SAFE_INTEGER;
          const rightRank = priorityByMemoryId.get(right.memory_entry_id) ?? Number.MAX_SAFE_INTEGER;
          return leftRank - rightRank;
        })
      );
    }
  };
  const pathPlasticityPort =
    input.pathPlasticityService === undefined
      ? undefined
      : {
          computeAndApplyPlasticity: input.pathPlasticityService.computeAndApplyPlasticity.bind(
            input.pathPlasticityService
          ),
          markProcessed: (params: {
            readonly workspaceId: string;
            readonly processedThroughIso: string;
            readonly processedAuditEventId?: string | null;
          }) => {
            pathPlasticityWatermark.markProcessed(
              params.workspaceId,
              params.processedThroughIso,
              params.processedAuditEventId ?? null,
              new Date().toISOString()
            );
          }
        };
  const auditorSchedulerPort = {
    reportCompletion: (
      result: Parameters<GardenScheduler["reportCompletion"]>[0]
    ) => gardenScheduler.reportCompletion(result)
  };
  const healthIssueGroupPort: AuditorHealthIssueGroupPort | undefined =
    input.healthIssueGroupRepo === undefined
      ? undefined
      : {
          findExistingGroup: (lookup) =>
            input.healthIssueGroupRepo!.findByCompositeKey(
              lookup.workspaceId,
              lookup.targetObjectId,
              lookup.causeKind
            ),
          upsertHealthIssueGroup: (group) => {
            input.healthIssueGroupRepo!.upsert(group);
          }
        };
  const auditor = new Auditor({
    evidenceCheckPort: auditorEvidenceCheckPort,
    pointerHealthPort: input.gardenDataPorts.pointerHealthPort,
    greenMaintenancePort: input.gardenDataPorts.greenMaintenancePort,
    bootstrappingPort: input.gardenDataPorts.bootstrappingPort,
    orphanDetectionPort,
    scheduler: auditorSchedulerPort,
    healthJournal: healthJournalPort,
    eventLogRepo: auditorEventLogPort,
    ...(healthIssueGroupPort === undefined ? {} : { healthIssueGroupPort })
  });

  const librarianSchedulerPort: LibrarianSchedulerPort = {
    reportCompletion: (result) => gardenScheduler.reportCompletion(result)
  };
  const librarian = new Librarian({
    mergePort: input.gardenDataPorts.mergePort,
    neighborPort: input.gardenDataPorts.neighborPort,
    compressionPort: input.gardenDataPorts.compressionPort,
    synthesisPort: input.gardenDataPorts.synthesisPort,
    ...(pathPlasticityPort === undefined ? {} : { pathPlasticityPort }),
    pathPlasticityPendingPort: {
      clearPendingWorkspace: (workspaceId: string) => {
        pendingPathPlasticityWorkspaces.delete(workspaceId);
      }
    },
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
        warn("garden backlog telemetry observer capture failed", {
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  };

  const enqueueForAllWorkspaces = async (
    taskKind: GardenTaskKindValue,
    requiredTier: GardenTierValue,
    resolveTargetObjectRefs: (workspaceId: string, nowIso: string) => readonly string[] = () => []
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
        target_object_refs: resolveTargetObjectRefs(workspace.workspace_id, nowIso),
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
        gardenScheduler.enqueue({
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
      requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.PATH_PLASTICITY_UPDATE}`);
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
          event_type: RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
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
          warn("garden path graph snapshot prune failed after persistence", {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      await gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: false,
        objects_affected: [],
        audit_entries: [],
        error_message: errorMessage,
        completed_at: completedAt
      });
      warn("embedding backfill task failed; continuing Garden background pass", {
        workspace_id: task.workspace_id,
        error: errorMessage
      });
    } finally {
      pendingEmbeddingBackfillWorkspaces.delete(task.workspace_id);
    }
  };

  // invariant: memory_consolidation_enabled (SoulConfig, default true) gates
  // the executor. When false the task is reported complete as a no-op so the
  // queue drains. The plan is empty here: no planner produces structural
  // PathRelation mutations yet, so each cycle is a budget-charged no-op that
  // exercises the executor + budget + fuse path end-to-end.
  const runConsolidationCycleTask = async (
    task: Readonly<GardenTaskDescriptor>
  ): Promise<void> => {
    const completedAt = new Date().toISOString();
    try {
      if (consolidationExecutor === null) {
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

      const plan: ConsolidationCyclePlan = {
        workspace_id: task.workspace_id,
        planned_at: completedAt,
        promotions: [],
        retirements: [],
        governance_changes: [],
        direction_changes: [],
        fuse_state: { blown: false, retry_count: 0 }
      };
      const result = await consolidationExecutor.runCycle({
        triggerSource: "native_surface_drift",
        plan
      });
      await reportConsolidationCycleCompletion(task, completedAt, true, [
        `consolidation_cycle:fuse_${result.fuse_outcome}`
      ]);
    } catch (error) {
      await reportConsolidationCycleCompletion(task, completedAt, false, [], error);
      warn("consolidation cycle task failed; continuing Garden background pass", {
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
    await gardenScheduler.reportCompletion({
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

  const processPostTurnExtractTask = async (): Promise<void> => {
    if (
      gardenTaskRepo === undefined ||
      input.configService === undefined ||
      input.signalReceiver === undefined
    ) {
      return;
    }

    const row = gardenTaskRepo
      .peekPending(GardenRole.LIBRARIAN, undefined, 50)
      .find((candidate) => candidate.kind === GardenTaskKind.POST_TURN_EXTRACT);
    if (row === undefined) {
      return;
    }

    const config = await input.configService.getRuntimeGardenComputeConfig();
    const provider = selectPostTurnExtractProvider(config);
    if (provider === null) {
      return;
    }

    const claimedAt = new Date().toISOString();
    const claimResult = gardenTaskRepo.claimAtomic(
      row.id,
      IN_PROCESS_POST_TURN_CLAIMANT,
      claimedAt,
      row.workspace_id
    );
    if (claimResult !== "claimed") {
      return;
    }

    let dispatched = false;
    let payload: PostTurnExtractTaskPayload | null = null;
    try {
      payload = parsePostTurnExtractTaskPayload(row.payload);
      await input.eventPublisher.publish({
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_type: "garden_task",
        entity_id: row.id,
        workspace_id: row.workspace_id,
        run_id: payload.run_id,
        caused_by: "garden-runtime",
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, {
          task_id: row.id,
          task_kind: GardenTaskKind.POST_TURN_EXTRACT,
          role: GardenRole.LIBRARIAN,
          tier: GardenTier.TIER_2,
          workspace_id: row.workspace_id,
          run_id: payload.run_id,
          occurred_at: claimedAt
        })
      });
      dispatched = true;

      const candidateSignals = await compilePostTurnExtractTask(provider, payload);

      const emittedSignalIds: string[] = [];
      for (const [index, signal] of candidateSignals.entries()) {
        if (
          !gardenTaskRepo.refreshClaim(
            row.id,
            IN_PROCESS_POST_TURN_CLAIMANT,
            new Date().toISOString()
          )
        ) {
          throw new Error(`Garden task ${row.id} claim changed before candidate signal emission.`);
        }
        const received = await input.signalReceiver.receiveSignal(
          CandidateMemorySignalSchema.parse({
            ...signal,
            signal_id: buildGardenTaskSignalId(row.id, index)
          })
        );
        emittedSignalIds.push(received.signal.signal_id);
      }

      const completedAt = new Date().toISOString();
      await gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: "completed",
          completed_at: completedAt
        },
        [
          {
            event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
            entity_type: "garden_task",
            entity_id: row.id,
            workspace_id: row.workspace_id,
            run_id: payload.run_id,
            caused_by: "garden-runtime",
            payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
              task_id: row.id,
              task_kind: GardenTaskKind.POST_TURN_EXTRACT,
              role: GardenRole.LIBRARIAN,
              tier: GardenTier.TIER_2,
              success: true,
              objects_affected: emittedSignalIds,
              candidate_signals_count: emittedSignalIds.length,
              workspace_id: row.workspace_id,
              occurred_at: completedAt
            })
          }
        ],
        IN_PROCESS_POST_TURN_CLAIMANT
      );
    } catch (error) {
      if (!dispatched) {
        gardenTaskRepo.releaseClaim(row.id, IN_PROCESS_POST_TURN_CLAIMANT);
        throw error;
      }

      // A dispatched task that fails during extraction (provider error, bad
      // response, ...) is recorded as failed with the error captured in
      // last_error_text and a SOUL_GARDEN_TASK_COMPLETED(success: false)
      // event. We do NOT rethrow: post-turn extract is fire-and-forget and
      // runs on every recall, so a flaky compute provider must not abort the
      // rest of the Garden background pass.
      const completedAt = new Date().toISOString();
      await gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: "failed",
          completed_at: completedAt,
          last_error_text: error instanceof Error ? error.message : String(error)
        },
        [
          {
            event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
            entity_type: "garden_task",
            entity_id: row.id,
            workspace_id: row.workspace_id,
            run_id: payload?.run_id ?? null,
            caused_by: "garden-runtime",
            payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
              task_id: row.id,
              task_kind: GardenTaskKind.POST_TURN_EXTRACT,
              role: GardenRole.LIBRARIAN,
              tier: GardenTier.TIER_2,
              success: false,
              objects_affected: [],
              candidate_signals_count: 0,
              workspace_id: row.workspace_id,
              occurred_at: completedAt
            })
          }
        ],
        IN_PROCESS_POST_TURN_CLAIMANT
      );
    }
  };

  const selectPostTurnExtractProvider = (
    config: RuntimeGardenComputeConfig
  ): GardenComputeProvider | null => {
    if (config.provider_kind === "host_worker") {
      return null;
    }

    if (config.provider_kind === "official_api") {
      return config.enabled && input.officialApiGardenProvider !== undefined
        ? input.officialApiGardenProvider
        : null;
    }

    return input.localHeuristicsProvider ?? null;
  };

  const compilePostTurnExtractTask = async (
    provider: GardenComputeProvider,
    payload: PostTurnExtractTaskPayload
  ): Promise<readonly CandidateMemorySignal[]> => {
    const context: GardenCompileContext = {
      workspace_id: payload.workspace_id,
      run_id: payload.run_id,
      surface_id: null,
      turn_messages: buildPostTurnConversationMessages(payload)
    };
    const signals = await provider.compile(buildPostTurnContent(payload), context);
    return Object.freeze(
      signals.map((signal) => {
        const parsed = CandidateMemorySignalSchema.parse(signal);
        if (parsed.workspace_id !== payload.workspace_id || parsed.run_id !== payload.run_id) {
          throw new Error("Post-turn extract candidate signal escaped the task workspace or run.");
        }
        return normalizeSchemaGroundedSignal(parsed);
      })
    );
  };

  let lastBackgroundPassAt: string | null = null;
  const markBackgroundPassCompleted = (): void => {
    lastBackgroundPassAt = new Date().toISOString();
  };

  const reclaimAbandonedGardenClaims = async (repo: SqliteGardenTaskRepo): Promise<void> => {
    const occurredAt = new Date().toISOString();
    const abandonedClaims = repo.peekAbandonedClaims(
      occurredAt,
      GARDEN_CLAIM_STALE_AFTER_MS
    );
    const reclaims: GardenTaskReclaimInput[] = [];
    for (const row of abandonedClaims) {
      if (row.claimed_by === null || row.claimed_at === null) {
        continue;
      }
      const runId = extractGardenTaskRunId(row.payload);
      reclaims.push({
        task_id: row.id,
        claimed_by: row.claimed_by,
        claimed_at: row.claimed_at,
        event: {
          event_type: GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
          entity_type: "garden_task",
          entity_id: row.id,
          workspace_id: row.workspace_id,
          run_id: runId,
          caused_by: "garden-runtime",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, {
            task_id: row.id,
            task_kind: row.kind,
            role: row.role,
            tier: GARDEN_ROLE_TIER_MAP[row.role],
            workspace_id: row.workspace_id,
            run_id: runId,
            previous_claimed_by: row.claimed_by,
            claimed_at: row.claimed_at,
            stale_after_ms: GARDEN_CLAIM_STALE_AFTER_MS,
            occurred_at: occurredAt
          })
        }
      });
    }
    await repo.gcAbandonedClaims(reclaims);
  };

  const backgroundServices = [
    {
      name: "Janitor",
      intervalMs: 300_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.TTL_CLEANUP, GardenTier.TIER_0);
        markBackgroundPassCompleted();
      }
    },
    {
      name: "Auditor",
      intervalMs: 1_800_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.EVIDENCE_STALENESS_CHECK, GardenTier.TIER_1);
        if (input.orphanDetectionEnabled) {
          await enqueueForAllWorkspaces(GardenTaskKind.ORPHAN_DETECTION, GardenTier.TIER_1);
          await enqueueForAllWorkspaces(GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION, GardenTier.TIER_1);
        }
        markBackgroundPassCompleted();
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
        await enqueuePathPlasticityForAllWorkspaces();
        await enqueueForAllWorkspaces(
          GardenTaskKind.PATH_GRAPH_SNAPSHOT,
          GardenTier.TIER_2,
          (workspaceId) => [workspaceId]
        );
        if (consolidationExecutor !== null) {
          await enqueueForAllWorkspaces(
            GardenTaskKind.CONSOLIDATION_CYCLE,
            GardenTier.TIER_2,
            (workspaceId) => [workspaceId]
          );
        }
        markBackgroundPassCompleted();
      }
    },
    {
      name: "GardenScheduler",
      intervalMs: 60_000,
      task: async () => {
        if (gardenTaskRepo !== undefined) {
          await reclaimAbandonedGardenClaims(gardenTaskRepo);
        }
        await processPostTurnExtractTask();
        for (const [role, handler, runtimeTaskKinds] of [
          [GardenRole.JANITOR, janitor, JANITOR_RUNTIME_TASK_KINDS],
          [GardenRole.AUDITOR, auditor, AUDITOR_RUNTIME_TASK_KINDS],
          [GardenRole.LIBRARIAN, librarian, LIBRARIAN_RUNTIME_TASK_KINDS]
        ] as const) {
          const task = await runtimeGardenScheduler.dispatchNextMatchingTaskKind(
            role,
            runtimeTaskKinds
          );
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

          if (task.task_kind === GardenTaskKind.CONSOLIDATION_CYCLE) {
            await runConsolidationCycleTask(task);
            continue;
          }

          await handler.run(task);
        }
        markBackgroundPassCompleted();
      }
    }
  ];
  const backgroundManager = new BackgroundServiceManager(backgroundServices, {
    logger: { warn }
  });

  return Object.freeze({
    backgroundManager,
    backlogTelemetrySource,
    getStatus: () => ({
      last_pass_at: lastBackgroundPassAt
    }),
    runEventLogOrphanDetection: async () => {
      if (!input.orphanDetectionEnabled) {
        return;
      }

      await enqueueForAllWorkspaces(GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION, GardenTier.TIER_1);

      while (true) {
        const task = await runtimeGardenScheduler.dispatchNextMatchingTaskKind(
          GardenRole.AUDITOR,
          [GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION]
        );
        requestBacklogTelemetryCapture("startup:event_log_orphan_detection");
        if (task === null) {
          break;
        }

        await auditor.run(task);
      }
    },
    runBackgroundPass: async () => {
      for (const service of backgroundServices) {
        await service.task();
      }
      markBackgroundPassCompleted();
      const workspaces = await input.workspaceRepo.list();
      const workspaceIds =
        workspaces.length === 0
          ? [DEFAULT_GARDEN_STATUS_WORKSPACE_ID]
          : workspaces.map((workspace) => workspace.workspace_id);
      for (const workspaceId of workspaceIds) {
        await healthJournalPort.record({
          event_kind: HealthEventKind.GARDEN_BACKLOG,
          workspace_id: workspaceId,
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

function defaultGardenRuntimeWarn(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}

function parsePostTurnExtractTaskPayload(payload: unknown): PostTurnExtractTaskPayload {
  if (!isRecord(payload)) {
    throw new Error("Invalid post-turn extract task payload.");
  }

  const runId = parseStringField(payload, "run_id");
  const workspaceId = parseStringField(payload, "workspace_id");
  const turnIndex = payload.turn_index;
  const turnDigest = payload.turn_digest;
  if (
    typeof turnIndex !== "number" ||
    !Number.isInteger(turnIndex) ||
    turnIndex < 0 ||
    !isRecord(turnDigest)
  ) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  const parsedTurnIndex = turnIndex as number;

  const contextManifest = turnDigest.context_manifest;
  const lastMessages = Array.isArray(turnDigest.last_messages)
    ? turnDigest.last_messages.map(parsePostTurnDigestMessage)
    : [];
  const deliveredObjectIds =
    isRecord(contextManifest) && Array.isArray(contextManifest.delivered_object_ids)
      ? contextManifest.delivered_object_ids.filter((id): id is string => typeof id === "string")
      : [];

  return {
    run_id: runId,
    turn_index: parsedTurnIndex,
    workspace_id: workspaceId,
    turn_digest: {
      last_messages: Object.freeze(lastMessages),
      context_manifest: {
        delivered_object_ids: Object.freeze([...new Set(deliveredObjectIds)])
      }
    }
  };
}

function parsePostTurnDigestMessage(value: unknown): {
  readonly role: string;
  readonly content_excerpt: string;
} {
  if (!isRecord(value)) {
    return { role: "user", content_excerpt: "" };
  }

  const role = typeof value.role === "string" && value.role.trim().length > 0 ? value.role : "user";
  const contentExcerpt =
    typeof value.content_excerpt === "string"
      ? value.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
      : "";
  return { role, content_excerpt: contentExcerpt };
}

function buildPostTurnContent(payload: PostTurnExtractTaskPayload): string {
  return payload.turn_digest.last_messages
    .map((message) => `${message.role}: ${message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)}`)
    .join("\n\n");
}

function buildPostTurnConversationMessages(
  payload: PostTurnExtractTaskPayload
): readonly ConversationMessage[] {
  return Object.freeze(
    payload.turn_digest.last_messages.map((message, index) => {
      const role: ConversationMessage["role"] = message.role === "assistant" ? "assistant" : "user";
      return {
        message_id: `post-turn-${payload.run_id}-${payload.turn_index}-${index}`,
        role,
        content: message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
      };
    })
  );
}

function parseStringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return value;
}

function extractGardenTaskRunId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.run_id !== "string" || payload.run_id.trim().length === 0) {
    return null;
  }
  return payload.run_id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
