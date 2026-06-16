import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  GardenEventType,
  GardenRole,
  type GardenBacklogThresholds,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  parseGardenEventPayload,
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
  type RuntimeGardenComputeConfig,
  type CandidateMemorySignal,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  type SoulConfig,
  ConsolidationTriggerBudgetSchema
} from "@do-soul/alaya-protocol";
import type {
  ConsolidationBudgetStorePort,
  EmbeddingBackfillHandler,
  EventPublisher,
  PathPlasticityService,
  StrongRefService
} from "@do-soul/alaya-core";
import { ConsolidationExecutor } from "@do-soul/alaya-core";
import {
  createGardenBackgroundDataPorts,
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
  type GardenComputeProvider,
  type GardenSchedulerEventLogPort,
  type JanitorControlPlaneCleanupPort,
  type JanitorDispositionSweepPort,
  type JanitorSchedulerPort,
  type JanitorTombstoneGcPort,
  type LibrarianSchedulerPort
} from "@do-soul/alaya-soul";
import { findEventLogOrphansForWorkspace, findOrphanedMemoriesForWorkspace } from "./orphan-query.js";
import { BackgroundServiceManager } from "../background/bootstrap.js";
import { buildGardenTaskSignalId } from "./task-signal-id.js";
import { createBulkEnrichRuntimeSupport } from "./bulk-enrich-runtime.js";
import { createHostWorkerTaskRuntimeSupport } from "./host-worker-runtime.js";
import { createGardenSchedulerRuntimeSupport } from "./scheduler-runtime-support.js";
type RuntimeGardenScheduler = GardenScheduler & {
  dispatchNextMatchingTaskKind(
    role: Parameters<GardenScheduler["dispatchNext"]>[0],
    taskKinds: readonly GardenTaskKindValue[],
    workspaceId?: string
  ): ReturnType<GardenScheduler["dispatchNext"]>;
};

const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";
// invariant: per ~60s scheduler pass, drain up to this many BULK_ENRICH tasks
// so every workspace whose enrich_pending grew this pass is enriched within
// the ~1-min bound (one Librarian dispatch per pass would push a multi-
// workspace backlog to O(workspaces) passes). Capped so a huge backlog cannot
// starve the other scheduler work that shares this pass; beyond the cap the
// bound degrades to O(workspaces / cap) * scheduler interval.
const BULK_ENRICH_DRAIN_CAP_PER_PASS = 32;
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
  GardenTaskKind.CONSOLIDATION_CYCLE,
  GardenTaskKind.BULK_ENRICH
] as const satisfies readonly GardenTaskKindValue[];

// invariant: the executor charges every consolidation cycle against the
// consolidation_trigger_budgets row for its trigger source (migration 035).
// see also: packages/core/src/memory/consolidation-executor.ts
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

// invariant: BULK_ENRICH drain-worker ports (S3c). The worker claims rows from
// enrich_pending, reconstructs the conflict-scan params from each persisted
// memory row (content/dimension/scope/domain_tags match buildMemoryInput),
// replays first-class signal refs from the persisted source signal, and runs
// the governed enrichment services owned by materialization. These narrow
// shapes keep the wiring decoupled from concrete storage/core types.
// see also: packages/storage/src/repos/enrich-pending-repo.ts
// see also: packages/soul/src/garden/materialization-router/contracts.ts EnrichPendingPort
interface BulkEnrichPendingPort {
  claimBatch(
    workspaceId: string,
    limit: number,
    claimedAt: string,
    maxAttempts: number
  ): readonly {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }[];
  markProcessed(workspaceId: string, memoryId: string, processedAt: string): void;
  // invariant: bounded transient-retry seam. Records a TRANSIENT failure against
  // a claimed marker; under the cap it releases the claim for retry, at/over the
  // cap it dead-letters the marker (excluded from future claims) and returns
  // abandoned=true so the caller emits the SOUL_ENRICH_ABANDONED audit event.
  recordFailedAttempt(
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ): { readonly attemptCount: number; readonly abandoned: boolean };
  delete(workspaceId: string, memoryId: string): void;
  countPending(workspaceId: string): number;
  reclaimStale(now: string, staleAfterMs: number): number;
}

interface BulkEnrichMemoryLookupPort {
  findById(memoryId: string): Promise<
    | Readonly<{
        readonly object_id: string;
        readonly dimension: string;
        readonly scope_class: string;
        readonly content: string;
        readonly domain_tags: readonly string[];
        readonly workspace_id: string;
        readonly run_id: string;
      }>
    | null
  >;
}

interface BulkEnrichConflictDetectionPort {
  detectAndLinkConflicts(params: {
    readonly newMemoryId: string;
    readonly newMemoryDimension: string;
    readonly newMemoryScopeClass: string;
    readonly newMemoryContent: string;
    readonly newMemoryDomainTags: readonly string[];
    readonly workspaceId: string;
    readonly runId: string;
    // invariant: the worker always passes strictNoDrop=true so a transient
    // candidate-query or path-mint failure throws (the per-memory catch
    // releases the claim for retry) instead of degrading to an empty
    // candidate set or a swallowed warn that markProcessed would lose.
    readonly strictNoDrop?: boolean;
  }): Promise<void>;
}

interface BulkEnrichEdgeProducerPort {
  produceForNewMemory(params: {
    readonly newMemoryId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
  }): Promise<void>;
}

// Crystallize coheres_with edges among the objects a backfill pass just embedded
// (design S). Fail-soft: a throw must never block backfill completion.
interface BulkEmbeddingCoherencePort {
  crystallizeForBackfill(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
  }): Promise<{ readonly minted: number }>;
}

interface BulkEnrichSourceSignalLookupPort {
  getById(signalId: string): Promise<CandidateMemorySignal | null>;
}

interface BulkEnrichSignalRefReplayPort {
  replaySignalRefs(params: {
    readonly newMemoryId: string;
    readonly signal: CandidateMemorySignal;
  }): Promise<void>;
}

// invariant: crash-window reconcile for the accept->mint handoff. acceptProposal
// commits the accept review row then mints the owed path separately; a crash
// between them strands a proposal accepted/auto_accepted with no path,
// invisible to the pending list. This sweep re-drives the owed mint
// idempotently (path dedup -> already_present). Bounded per pass and per
// workspace; returns the per-outcome tally the tick LOGs.
// see also: packages/core/src/path-graph/edge-proposal-service.ts reconcileStuckAccepts.
interface EdgeProposalReconcilePort {
  reconcileStuckAccepts(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly reminted: number;
    readonly already_present: number;
    readonly rejected: number;
    readonly transient_failed: number;
  }>;
  // invariant: TTL sweep. Flips pending proposals past their expires_at to
  // terminal `expired` (audited), bounded per pass/workspace. Runs on the same
  // ~60s pass as reconcileStuckAccepts. see also: edge-proposal-service.ts
  // sweepExpired; sweepExpiredEdgeProposals below.
  sweepExpired(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly expired: number;
    readonly skipped: number;
  }>;
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
  // When wired, a backfill pass crystallizes coheres_with edges among the objects
  // it just embedded (design S). Optional + fail-soft, like the enrich ports.
  readonly coherenceEdgeProducerPort?: BulkEmbeddingCoherencePort;
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
  // invariant: the GATED terminal forgetting ports (R3d). When wired, TOMBSTONE_GC
  // runs the autonomous dormant->tombstoned disposition sweep + the
  // disposition-gated physical GC. When absent, TOMBSTONE_GC is a safe no-op
  // (the prior posture — no autonomous deletion). Both gate on a durable
  // forget_disposition so an un-preserved/un-judged memory can never be removed.
  readonly tombstoneDispositionSweepPort?: JanitorDispositionSweepPort;
  readonly tombstoneGcPort?: JanitorTombstoneGcPort;
  // invariant: BULK_ENRICH wiring (S3c). When enrichPendingRepo + edgeProducer
  // are wired the Garden drains enrich_pending off the write-path; when absent
  // the task is a no-op (enrichment disabled, same as no service). The conflict
  // detection port is independently optional (it has its own enable flag).
  readonly enrichPendingRepo?: BulkEnrichPendingPort;
  readonly enrichMemoryLookup?: BulkEnrichMemoryLookupPort;
  readonly enrichConflictDetectionPort?: BulkEnrichConflictDetectionPort;
  readonly enrichEdgeProducerPort?: BulkEnrichEdgeProducerPort;
  readonly enrichSourceSignalLookup?: BulkEnrichSourceSignalLookupPort;
  readonly enrichSignalRefReplayPort?: BulkEnrichSignalRefReplayPort;
  // invariant: when wired, the ~60s GardenScheduler pass re-drives owed path
  // mints for accept->mint crash-window orphans (accepted/auto_accepted with no
  // path). Optional so unit tests and reduced wirings can omit it.
  // see also: edgeProposalReconcilePort, reconcileStuckEdgeProposalAccepts.
  readonly edgeProposalReconcile?: EdgeProposalReconcilePort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}): Readonly<{
  readonly backgroundManager: BackgroundServiceManager;
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  getStatus(): GardenRuntimeStatus;
  runEventLogOrphanDetection(): Promise<void>;
  runBackgroundPass(): Promise<void>;
  runBulkEnrichPass(workspaceId: string): Promise<void>;
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}> {
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
  const hostWorkerTaskRuntime = createHostWorkerTaskRuntimeSupport({
    gardenTaskRepo,
    configService: input.configService,
    eventPublisher: input.eventPublisher,
    localHeuristicsProvider: input.localHeuristicsProvider,
    officialApiGardenProvider: input.officialApiGardenProvider,
    signalReceiver: input.signalReceiver,
    warn
  });
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
  let requestBacklogTelemetryCapture = (_reason: string): void => {};
  let enqueueForAllWorkspaces = async (
    _taskKind: GardenTaskKindValue,
    _requiredTier: GardenTierValue,
    _resolveTargetObjectRefs: (workspaceId: string, nowIso: string) => readonly string[] = () => []
  ): Promise<void> => {};
  let runAuditorTask: ((task: Readonly<GardenTaskDescriptor>) => Promise<void>) | null = null;
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
    // REVERSIBLE: flips active -> dormant only (recall-silent, revived on use).
    dormantDemotionPort: input.gardenDataPorts.dormantDemotionPort,
    // GATED terminal removal (R3d). Both ports gate on a durable forget_disposition;
    // when omitted, TOMBSTONE_GC degrades to a safe no-op (no autonomous deletion).
    ...(input.tombstoneDispositionSweepPort === undefined
      ? {}
      : { dispositionSweepPort: input.tombstoneDispositionSweepPort }),
    ...(input.tombstoneGcPort === undefined ? {} : { tombstoneGcPort: input.tombstoneGcPort }),
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
  const gardenSchedulerRuntime = createGardenSchedulerRuntimeSupport({
    coherenceEdgeProducerPort: input.coherenceEdgeProducerPort,
    configService: input.configService,
    consolidationExecutor,
    embeddingBackfillHandler: input.embeddingBackfillHandler,
    edgeProposalReconcile: input.edgeProposalReconcile,
    enqueueForAllWorkspaces: (taskKind, requiredTier, resolveTargetObjectRefs) =>
      enqueueForAllWorkspaces(taskKind, requiredTier, resolveTargetObjectRefs),
    eventPublisher: input.eventPublisher,
    gardenScheduler,
    healthJournalPort,
    pathGraphSnapshotRepo: input.pathGraphSnapshotRepo,
    pathRelationRepo: input.pathRelationRepo,
    pathPlasticityWatermarkRepo: input.pathPlasticityWatermarkRepo,
    requestBacklogTelemetryCapture: (reason) => {
      requestBacklogTelemetryCapture(reason);
    },
    runtimeGardenScheduler,
    runAuditorTask: async (task) => {
      if (runAuditorTask === null) {
        throw new Error("garden auditor runtime is unavailable");
      }
      await runAuditorTask(task);
    },
    warn,
    workspaceRepo: input.workspaceRepo
  });
  const auditorEvidenceCheckPort = {
    findMemoriesWithStaleEvidence: async (workspaceId: string) => {
      const staleEntries =
        await input.gardenDataPorts.evidenceCheckPort.findMemoriesWithStaleEvidence(workspaceId);
      if (staleEntries.length <= 1) {
        return staleEntries;
      }
      const prioritized = await gardenSchedulerRuntime.auditorSchedulingAdvisor.prioritizeRechecksByBias(
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
          markProcessed: gardenSchedulerRuntime.markPathPlasticityProcessed
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
  runAuditorTask = async (task) => {
    await auditor.run(task);
  };

  const librarianSchedulerPort: LibrarianSchedulerPort = {
    reportCompletion: (result) => gardenScheduler.reportCompletion(result)
  };
  const librarian = new Librarian({
    mergePort: input.gardenDataPorts.mergePort,
    neighborPort: input.gardenDataPorts.neighborPort,
    compressionPort: input.gardenDataPorts.compressionPort,
    synthesisPort: input.gardenDataPorts.synthesisPort,
    ...(pathPlasticityPort === undefined ? {} : { pathPlasticityPort }),
    pathPlasticityPendingPort: gardenSchedulerRuntime.pathPlasticityPendingPort,
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

  requestBacklogTelemetryCapture = (reason: string): void => {
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

  const bulkEnrichRuntime = createBulkEnrichRuntimeSupport({
    enrichPendingRepo: input.enrichPendingRepo,
    enrichMemoryLookup: input.enrichMemoryLookup,
    enrichConflictDetectionPort: input.enrichConflictDetectionPort,
    enrichEdgeProducerPort: input.enrichEdgeProducerPort,
    enrichSourceSignalLookup: input.enrichSourceSignalLookup,
    enrichSignalRefReplayPort: input.enrichSignalRefReplayPort,
    eventPublisher: input.eventPublisher,
    gardenScheduler,
    gardenTaskRepo,
    onTaskEnqueued: requestBacklogTelemetryCapture,
    warn,
    workspaceRepo: input.workspaceRepo
  });

  enqueueForAllWorkspaces = async (
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

  let lastBackgroundPassAt: string | null = null;
  const markBackgroundPassCompleted = (): void => {
    lastBackgroundPassAt = new Date().toISOString();
  };

  const backgroundServices = [
    {
      name: "Janitor",
      intervalMs: 300_000,
      task: async () => {
        await enqueueForAllWorkspaces(GardenTaskKind.TTL_CLEANUP, GardenTier.TIER_0);
        // REVERSIBLE memory-side forgetting: demote faded+idle active memories
        // to lifecycle_state=dormant (recall-silent, revived on next use).
        await enqueueForAllWorkspaces(GardenTaskKind.DORMANT_DEMOTION, GardenTier.TIER_0);
        // invariant: TERMINAL forgetting (R3d). Runs the gated dormant->tombstoned
        // disposition sweep + the gated physical GC. Both are fail-closed: a row is
        // tombstoned only with a non-null forget_disposition (compressed-into-a-live-
        // capsule or judged_useless), and physically deleted only when it is past
        // the >=24h grace AND its compressed-member preservation is re-verified
        // atomically with the DELETE. When the disposition/GC ports are unwired the
        // task is a safe no-op.
        // see also: packages/soul/src/garden/janitor.ts executeTombstoneGc,
        // apps/core-daemon/src/garden/forget-disposition-ports.ts computeForgetDisposition.
        await enqueueForAllWorkspaces(GardenTaskKind.TOMBSTONE_GC, GardenTier.TIER_0);
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
          await gardenSchedulerRuntime.enqueueEmbeddingBackfillForAllWorkspaces();
        }
        await gardenSchedulerRuntime.enqueuePathPlasticityForAllWorkspaces();
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
        // invariant: the unconditional per-workspace BULK_ENRICH drain runs on
        // the ~60s GardenScheduler pass, not here. That pass drains every
        // BULK_ENRICH queued in the pass (up to BULK_ENRICH_DRAIN_CAP_PER_PASS),
        // so conflict-suppression edges form within a ~1-min best-effort-eventual
        // bound for up to the cap many workspaces per pass.
        // see also: enqueueBulkEnrichForAllWorkspaces.
        markBackgroundPassCompleted();
      }
    },
    {
      name: "GardenScheduler",
      intervalMs: 60_000,
      task: async () => {
        if (gardenTaskRepo !== undefined) {
          await hostWorkerTaskRuntime.reclaimAbandonedGardenClaims();
          await hostWorkerTaskRuntime.expireUnclaimedHostWorkerTasks();
        }
        bulkEnrichRuntime.reclaimStaleClaims();
        await gardenSchedulerRuntime.reconcileStuckEdgeProposalAccepts();
        // expire past-TTL pending edge proposals so the unreviewed
        // backlog cannot grow unbounded on a no-reviewer deployment.
        await gardenSchedulerRuntime.sweepExpiredEdgeProposals();
        await hostWorkerTaskRuntime.processPostTurnExtractTask();
        // invariant: drain enrich_pending on the ~60s cadence (not the 15-min
        // Librarian pass) so conflict-suppression edges form within a ~1-min
        // best-effort-eventual bound. The unconditional drain covers slow drip;
        // the threshold trigger below covers bursts. Both enqueue only when
        // there is something to drain, so a 60s all-workspace check is near-free.
        const bulkEnrichEnqueuedThisPass = new Set<string>();
        await bulkEnrichRuntime.enqueueForAllWorkspaces(bulkEnrichEnqueuedThisPass);
        await bulkEnrichRuntime.enqueueForCountThreshold(bulkEnrichEnqueuedThisPass);
        // invariant: drain EVERY BULK_ENRICH queued this pass, not just one, so
        // a multi-workspace backlog all enriches within the ~1-min bound rather
        // than O(workspaces) passes. Bounded by BULK_ENRICH_DRAIN_CAP_PER_PASS
        // so a huge backlog cannot starve the per-role dispatch that shares this
        // pass; beyond the cap the bound degrades to O(workspaces / cap) * pass.
        // Runs before the per-role loop so BULK_ENRICH does not consume the
        // single Librarian dispatch slot the other Librarian task kinds need.
        for (let drained = 0; drained < BULK_ENRICH_DRAIN_CAP_PER_PASS; drained += 1) {
          const bulkEnrichTask = await runtimeGardenScheduler.dispatchNextMatchingTaskKind(
            GardenRole.LIBRARIAN,
            [GardenTaskKind.BULK_ENRICH]
          );
          if (bulkEnrichTask === null) {
            break;
          }
          await bulkEnrichRuntime.runTask(bulkEnrichTask);
        }
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
            await gardenSchedulerRuntime.runPathGraphSnapshotTask(task);
            continue;
          }

          if (task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL) {
            await gardenSchedulerRuntime.runEmbeddingBackfillTask(task);
            continue;
          }

          if (task.task_kind === GardenTaskKind.CONSOLIDATION_CYCLE) {
            await gardenSchedulerRuntime.runConsolidationCycleTask(task);
            continue;
          }

          if (task.task_kind === GardenTaskKind.BULK_ENRICH) {
            await bulkEnrichRuntime.runTask(task);
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
    runEventLogOrphanDetection: () => gardenSchedulerRuntime.runEventLogOrphanDetection(),
    // invariant: targeted BULK_ENRICH drain for bench edge-plane readiness.
    // This processes only the requested workspace's currently claimable
    // enrich_pending rows; it does not reclaim stale claims, enqueue garden
    // tasks, or advance unrelated maintenance on sibling workspaces.
    runBulkEnrichPass: async (workspaceId: string) => {
      await bulkEnrichRuntime.runClaimableWorkspacePass(
        workspaceId,
        BULK_ENRICH_DRAIN_CAP_PER_PASS
      );
    },
    runEmbeddingBackfillPass: (workspaceId: string) =>
      gardenSchedulerRuntime.runEmbeddingBackfillPass(workspaceId),
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
