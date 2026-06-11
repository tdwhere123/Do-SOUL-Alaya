import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  DYNAMICS_CONSTANTS,
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
  ConsolidationPlanner,
  createVerificationBiasReaderFromPathLookup,
  isEmbeddingBackfillPartialFailureError
} from "@do-soul/alaya-core";
import {
  createGardenBackgroundDataPorts,
  type GardenTaskExpiryInput,
  type GardenTaskReclaimInput,
  type GardenTaskRow,
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
  type JanitorDispositionSweepPort,
  type JanitorSchedulerPort,
  type JanitorTombstoneGcPort,
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
type EmbeddingBackfillTaskOutcome = Readonly<{
  readonly success: boolean;
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
  readonly errorMessage: string | null;
}>;
type RuntimeGardenScheduler = GardenScheduler & {
  dispatchNextMatchingTaskKind(
    role: Parameters<GardenScheduler["dispatchNext"]>[0],
    taskKinds: readonly GardenTaskKindValue[],
    workspaceId?: string
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
// invariant: host_worker is the product default (Alaya owns no LLM). A
// POST_TURN_EXTRACT task is left PENDING for an attached CLI agent to claim and
// run as LLM-quality extraction. But host_worker would silently stall forever
// if no agent is ever attached, so after this bounded window with no host-worker
// claim the in-process runtime falls back to the deterministic, zero-cloud
// localHeuristicsProvider for that row. This keeps the agent-first LLM path
// (an attached worker claims well within the window) while guaranteeing extract
// work never sits unclaimed indefinitely. 15 min > the 10-min stale-claim TTL so
// a worker that claimed-then-died still gets reclaimed-and-retried by a real
// host before the heuristic fallback fires. doctor/status warn when host_worker
// is the default and no worker has claimed recently so the operator knows to
// attach an agent for LLM quality (else it runs on heuristics).
const HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS = 15 * 60 * 1000;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;
// invariant: per ~60s scheduler pass, drain up to this many BULK_ENRICH tasks
// so every workspace whose enrich_pending grew this pass is enriched within
// the ~1-min bound (one Librarian dispatch per pass would push a multi-
// workspace backlog to O(workspaces) passes). Capped so a huge backlog cannot
// starve the other scheduler work that shares this pass; beyond the cap the
// bound degrades to O(workspaces / cap) * scheduler interval.
const BULK_ENRICH_DRAIN_CAP_PER_PASS = 32;
// invariant: per targeted embedding-backfill drain (runEmbeddingBackfillPass),
// dispatch at most this many EMBEDDING_BACKFILL tasks. One drain enqueues one
// task whose O(n) handle() embeds the whole workspace hot corpus, so a single
// dispatch is the normal case; the cap bounds termination if a task fails and
// is re-queued, so a stuck embedding cannot spin the warmup forever.
const EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS = 8;
// invariant: per ~60s pass, re-drive at most this many accept->mint crash-window
// orphans per workspace so a backlog of stranded accepts drains without starving
// the other reclaim work that shares this pass. Beyond the cap the bound degrades
// to O(stranded / cap) passes; oldest-first ordering keeps it FIFO-fair.
// see also: packages/core/src/path-graph/edge-proposal-service.ts reconcileStuckAccepts.
const EDGE_PROPOSAL_RECONCILE_CAP_PER_PASS = 32;
// invariant: per ~60s pass, expire at most this many past-TTL pending edge
// proposals per workspace so the TTL sweep shares the pass without starving
// other reclaim work. Beyond the cap the bound degrades to O(expired / cap)
// passes; oldest-expiry-first keeps the sweep FIFO-fair.
const EDGE_PROPOSAL_EXPIRY_CAP_PER_PASS = 64;
// invariant: never-claimed host-worker tasks (EDGE_CLASSIFY /
// POST_TURN_EXTRACT) outlive their usefulness on a no-agent deployment — the
// heuristic edge / extract already stands, and a stale unclaimed LLM-refinement
// task just grows garden_tasks unbounded. 7 days is conservative: far beyond the
// 15-min host-worker fallback window and the 10-min stale-claim reclaim, so a
// real attached worker has had every chance to claim, yet bounded enough that a
// no-agent deployment's queue cannot grow without limit.
const HOST_WORKER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// invariant: per ~60s pass, expire at most this many unclaimed host-worker tasks
// per kind so the delete sweep shares the pass; oldest-first FIFO.
const HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS = 128;
// invariant: the host-worker-only kinds whose never-claimed pending rows the TTL
// sweep removes. Both are enqueued for an attached CLI agent; neither is claimed
// by an in-process role, so neither completeWithEvents nor gcAbandonedClaims ever
// removes an unclaimed one. see also: protocol garden-tier.ts (host-worker kinds).
const HOST_WORKER_TTL_TASK_KINDS = [
  GardenTaskKind.EDGE_CLASSIFY,
  GardenTaskKind.POST_TURN_EXTRACT
] as const satisfies readonly GardenTaskKindValue[];
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
  // invariant: B5(a) TTL sweep. Flips pending proposals past their expires_at to
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
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
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

  // invariant: BULK_ENRICH is wired only when there is somewhere to drain to.
  // enrichPendingRepo + enrichMemoryLookup are mandatory; at least one
  // enrichment service must be present, mirroring the inline gate the
  // write-path used (a missing service meant that half of enrichment was off).
  const bulkEnrichWired =
    input.enrichPendingRepo !== undefined &&
    input.enrichMemoryLookup !== undefined &&
    (input.enrichEdgeProducerPort !== undefined ||
      input.enrichConflictDetectionPort !== undefined ||
      input.enrichSignalRefReplayPort !== undefined);

  const enqueueBulkEnrichForWorkspace = (workspaceId: string, nowIso: string): void => {
    gardenScheduler.enqueue({
      task_id: randomUUID(),
      task_kind: GardenTaskKind.BULK_ENRICH,
      required_tier: GardenTier.TIER_2,
      workspace_id: workspaceId,
      run_id: null,
      target_object_refs: [workspaceId],
      priority: 10,
      created_at: nowIso
    });
    requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.BULK_ENRICH}`);
  };

  // The dedup set is the authoritative per-pass guard: both triggers run in the
  // same scheduler pass, and peekPending(gardenTaskRepo) does not reflect a task
  // enqueued earlier in this same pass (and is a no-op when gardenTaskRepo is
  // unwired), so a workspace enqueued by the unconditional drain would otherwise
  // be re-enqueued by the threshold trigger before the first task is visible.
  const hasBulkEnrichQueued = (
    workspaceId: string,
    enqueuedThisPass: ReadonlySet<string>
  ): boolean =>
    enqueuedThisPass.has(workspaceId) ||
    (gardenTaskRepo
      ?.peekPending(GardenRole.LIBRARIAN, workspaceId, 50)
      .some((candidate) => candidate.kind === GardenTaskKind.BULK_ENRICH) ??
      false);

  // invariant: unconditional per-workspace drain, run on the ~60s GardenScheduler
  // pass so a freshly materialized memory's conflict-suppression edges form
  // within a ~1-min best-effort-eventual bound (the scheduler pass drains every
  // BULK_ENRICH queued here, up to BULK_ENRICH_DRAIN_CAP_PER_PASS, so the bound
  // holds across multiple workspaces in one pass). Guarded by countPending>0 (an
  // empty workspace enqueues nothing — a 60s all-workspace check is near-free)
  // AND no-BULK_ENRICH-already-queued (a backlog cannot stack duplicate tasks
  // faster than the worker drains them).
  const enqueueBulkEnrichForAllWorkspaces = async (
    enqueuedThisPass: Set<string>
  ): Promise<void> => {
    const enrichPendingRepo = input.enrichPendingRepo;
    if (!bulkEnrichWired || enrichPendingRepo === undefined) {
      return;
    }
    const workspaces = await input.workspaceRepo.list();
    const nowIso = new Date().toISOString();
    for (const workspace of workspaces) {
      if (enrichPendingRepo.countPending(workspace.workspace_id) === 0) {
        continue;
      }
      if (hasBulkEnrichQueued(workspace.workspace_id, enqueuedThisPass)) {
        continue;
      }
      enqueueBulkEnrichForWorkspace(workspace.workspace_id, nowIso);
      enqueuedThisPass.add(workspace.workspace_id);
    }
  };

  // OQ5 = both triggers. enqueueBulkEnrichForAllWorkspaces covers the slow-drip
  // case (any pending row, drained within the ~1-min bound); this count-threshold
  // trigger covers a burst (bulk import / heavy turn) so enrichment never lags
  // batch_trigger_count writes behind a draining cycle. Only enqueues for a
  // workspace whose pending count crossed the threshold and that has no
  // BULK_ENRICH already queued, so a backlog cannot stack duplicate tasks faster
  // than the worker drains them.
  const enqueueBulkEnrichForCountThreshold = async (
    enqueuedThisPass: Set<string>
  ): Promise<void> => {
    const enrichPendingRepo = input.enrichPendingRepo;
    if (!bulkEnrichWired || enrichPendingRepo === undefined) {
      return;
    }
    const workspaces = await input.workspaceRepo.list();
    const nowIso = new Date().toISOString();
    for (const workspace of workspaces) {
      const pending = enrichPendingRepo.countPending(workspace.workspace_id);
      if (pending < DYNAMICS_CONSTANTS.enrich.batch_trigger_count) {
        continue;
      }
      if (hasBulkEnrichQueued(workspace.workspace_id, enqueuedThisPass)) {
        continue;
      }
      enqueueBulkEnrichForWorkspace(workspace.workspace_id, nowIso);
      enqueuedThisPass.add(workspace.workspace_id);
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

      // Formation-side coheres_with crystallization over the just-embedded objects
      // (design S). Fail-soft: coherence is supplementary, never blocks backfill.
      if (input.coherenceEdgeProducerPort !== undefined && result.objectsAffected.length >= 2) {
        try {
          await input.coherenceEdgeProducerPort.crystallizeForBackfill({
            workspaceId: task.workspace_id,
            runId: null,
            objectIds: result.objectsAffected
          });
        } catch (coherenceError) {
          warn("coherence crystallization failed after embedding backfill", {
            workspace_id: task.workspace_id,
            error: coherenceError instanceof Error ? coherenceError.message : String(coherenceError)
          });
        }
      }

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
      await gardenScheduler.reportCompletion({
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
      warn("embedding backfill task failed; continuing Garden background pass", {
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

  // invariant: memory_consolidation_enabled (SoulConfig, default true) gates
  // the executor. When false the task is reported complete as a no-op so the
  // queue drains. The plan comes from the ConsolidationPlanner, which scans
  // dormant PathRelation rows and emits MERGE entries through the shared
  // importance gate; the executor re-enforces that gate at the delete site.
  // Consolidation is a SYSTEM Garden decision — no agent input drives a merge.
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

      // Reuse the same SqlitePathRelationRepo wired into the executor; its
      // findDormant satisfies ConsolidationPlannerPathRelationPort. Pin the
      // planner clock to completedAt so planned_at matches the cycle timestamp.
      const planner = new ConsolidationPlanner({
        pathRelationRepo: input.pathRelationRepo,
        now: () => completedAt
      });
      const plan = await planner.planCycle(task.workspace_id);
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

  // invariant: BULK_ENRICH drain worker (S3c). Claims a batch from
  // enrich_pending and, for each claimed memory, reconstructs the conflict-scan
  // params from the persisted memory row, replays first-class signal refs from
  // the persisted source signal, and runs the governed materialization services
  // (detectAndLinkConflicts + produceForNewMemory). Enrichment is a SYSTEM Garden decision — no agent
  // input drives it; the services own the truth boundary, this worker only
  // moves WHEN they run. Idempotent: detectAndLinkConflicts / produceForNewMemory
  // dedupe their path candidates, and markProcessed + the UNIQUE(workspace,memory)
  // constraint prevent a re-drain from duplicating work. A per-memory failure
  // releases the claim so a later cycle retries — no enrichment is dropped. When
  // the enrichment ports are unwired the task is a no-op so the queue is inert.
  // see also: packages/storage/src/repos/enrich-pending-repo.ts
  // see also: packages/soul/src/garden/materialization-router/router.ts enqueueEnrichment
  const runBulkEnrichTask = async (task: Readonly<GardenTaskDescriptor>): Promise<void> => {
    const completedAt = new Date().toISOString();
    const enrichPendingRepo = input.enrichPendingRepo;
    const memoryLookup = input.enrichMemoryLookup;
    const edgeProducer = input.enrichEdgeProducerPort;
    const conflictDetection = input.enrichConflictDetectionPort;
    const signalLookup = input.enrichSourceSignalLookup;
    const signalRefReplay = input.enrichSignalRefReplayPort;
    if (enrichPendingRepo === undefined || memoryLookup === undefined) {
      await reportBulkEnrichCompletion(task, completedAt, true, [
        "bulk_enrich_skipped:no_enrich_pending_table"
      ]);
      return;
    }
    if (edgeProducer === undefined && conflictDetection === undefined && signalRefReplay === undefined) {
      await reportBulkEnrichCompletion(task, completedAt, true, [
        "bulk_enrich_skipped:enrichment_disabled"
      ]);
      return;
    }

    try {
      const claimed = enrichPendingRepo.claimBatch(
        task.workspace_id,
        DYNAMICS_CONSTANTS.enrich.claim_batch_size,
        completedAt,
        DYNAMICS_CONSTANTS.enrich.max_attempts
      );
      let processedCount = 0;
      let missingCount = 0;
      let failedCount = 0;
      let abandonedCount = 0;
      for (const pending of claimed) {
        try {
          const memory = await memoryLookup.findById(pending.memoryId);
          if (memory === null) {
            // The memory was deleted (tombstone GC / cascade) before its
            // enrichment ran; there is nothing to enrich. Drop the stale row.
            enrichPendingRepo.delete(pending.workspaceId, pending.memoryId);
            missingCount += 1;
            continue;
          }
          if (signalRefReplay !== undefined && pending.sourceSignalId !== null) {
            if (signalLookup === undefined) {
              throw new Error("BULK_ENRICH signal-ref replay is wired without a source signal lookup port.");
            }
            const sourceSignal = await signalLookup.getById(pending.sourceSignalId);
            if (sourceSignal === null) {
              throw new Error(
                `BULK_ENRICH signal-ref replay could not load source signal ${pending.sourceSignalId}.`
              );
            }
            await signalRefReplay.replaySignalRefs({
              newMemoryId: memory.object_id,
              signal: sourceSignal
            });
          }
          if (edgeProducer !== undefined) {
            await edgeProducer.produceForNewMemory({
              newMemoryId: memory.object_id,
              workspaceId: memory.workspace_id,
              runId: memory.run_id,
              // The object_id fallback is provenance-only (feeds an audit
              // annotation), never a dedup / identity key.
              sourceSignalId: pending.sourceSignalId ?? memory.object_id
            });
          }
          if (conflictDetection !== undefined) {
            await conflictDetection.detectAndLinkConflicts({
              newMemoryId: memory.object_id,
              newMemoryDimension: memory.dimension,
              newMemoryScopeClass: memory.scope_class,
              newMemoryContent: memory.content,
              newMemoryDomainTags: memory.domain_tags,
              workspaceId: memory.workspace_id,
              runId: memory.run_id,
              // No-drop: a transient candidate-query or path-mint failure must
              // throw here so the catch below releases the claim (a later cycle
              // retries), never markProcessed an owed path away. A permanent
              // anchor rejection settles silently (no throw) — it is audited by
              // the path service and retrying it cannot help, so it does NOT
              // block markProcessed (no poison-pill retry loop).
              strictNoDrop: true
            });
          }
          // markProcessed runs only when every intended write settled
          // (applied / already_present / permanently rejected). Any transient
          // "failed" threw above and skipped this line, leaving the row claimed
          // for reclaimStale to release and a later cycle to retry.
          enrichPendingRepo.markProcessed(pending.workspaceId, pending.memoryId, completedAt);
          processedCount += 1;
        } catch (memoryError) {
          // Isolate a per-memory TRANSIENT failure (signal-ref replay,
          // produceForNewMemory, and detectAndLinkConflicts(strictNoDrop) throw
          // on transient path-mint failure; a permanent rejection settles
          // silently above and never reaches here). recordFailedAttempt bumps the
          // attempt counter and, under the cap, releases the claim for retry so
          // the marker is never dropped. At/over the cap it DEAD-LETTERS the
          // marker (excluded from future claims) instead of re-arming it forever,
          // and we emit a SOUL_ENRICH_ABANDONED audit event — a never-clearing
          // fault can no longer starve the per-pass claim budget, and the drop is
          // never silent.
          const failureKind =
            memoryError instanceof Error ? memoryError.message : String(memoryError);
          const outcome = enrichPendingRepo.recordFailedAttempt(
            pending.workspaceId,
            pending.memoryId,
            DYNAMICS_CONSTANTS.enrich.max_attempts,
            completedAt
          );
          failedCount += 1;
          if (outcome.abandoned) {
            abandonedCount += 1;
            await emitEnrichAbandoned(pending, outcome.attemptCount, failureKind, completedAt);
            warn("bulk enrich memory abandoned after exhausting retries; dead-lettered", {
              workspace_id: pending.workspaceId,
              memory_id: pending.memoryId,
              source_signal_id: pending.sourceSignalId,
              attempt_count: outcome.attemptCount,
              max_attempts: DYNAMICS_CONSTANTS.enrich.max_attempts,
              error: failureKind
            });
          } else {
            warn("bulk enrich memory failed; released claim for retry", {
              workspace_id: pending.workspaceId,
              memory_id: pending.memoryId,
              attempt_count: outcome.attemptCount,
              error: failureKind
            });
          }
        }
      }
      await reportBulkEnrichCompletion(task, completedAt, true, [
        `bulk_enrich:processed_${processedCount}`,
        `bulk_enrich:missing_${missingCount}`,
        `bulk_enrich:failed_${failedCount}`,
        `bulk_enrich:abandoned_${abandonedCount}`
      ]);
    } catch (error) {
      await reportBulkEnrichCompletion(task, completedAt, false, [], error);
      warn("bulk enrich task failed; continuing Garden background pass", {
        workspace_id: task.workspace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // invariant: governance/runtime drops must be auditable. A BULK_ENRICH marker
  // that exhausted its transient-retry budget is dead-lettered, not silently
  // dropped — this emits the EventLog record carrying the owed-work identity
  // (memory id + optional signal-ref), final attempt count, and last failure.
  // see also: packages/protocol/src/events/garden.ts SOUL_ENRICH_ABANDONED
  const emitEnrichAbandoned = async (
    pending: Readonly<{
      readonly workspaceId: string;
      readonly memoryId: string;
      readonly runId: string | null;
      readonly sourceSignalId: string | null;
    }>,
    attemptCount: number,
    lastFailureKind: string,
    occurredAt: string
  ): Promise<void> => {
    await input.eventPublisher.publish({
      event_type: GardenEventType.SOUL_ENRICH_ABANDONED,
      entity_type: "memory",
      entity_id: pending.memoryId,
      workspace_id: pending.workspaceId,
      run_id: pending.runId,
      caused_by: "garden-runtime",
      payload_json: parseGardenEventPayload(GardenEventType.SOUL_ENRICH_ABANDONED, {
        workspace_id: pending.workspaceId,
        memory_id: pending.memoryId,
        source_signal_id: pending.sourceSignalId,
        run_id: pending.runId,
        attempt_count: attemptCount,
        last_failure_kind: lastFailureKind,
        occurred_at: occurredAt
      })
    });
  };

  const reportBulkEnrichCompletion = async (
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
    const provider = selectPostTurnExtractProvider(config, row);
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
    config: RuntimeGardenComputeConfig,
    row: GardenTaskRow
  ): GardenComputeProvider | null => {
    if (config.provider_kind === "host_worker") {
      // Leave the row PENDING for an attached host worker (LLM quality) until
      // the bounded fallback window elapses. Past that window with no claim,
      // run the deterministic zero-cloud localHeuristicsProvider in-process so
      // the extract never stalls forever when no agent is attached. A freshly
      // enqueued task (within the window) stays null so peekPending still
      // surfaces it to the MCP worker loop. created_at is the enqueue time;
      // any unparseable timestamp is treated as "not yet stale" (keep waiting
      // for the worker) rather than firing the fallback early.
      const enqueuedAtMs = Date.parse(row.created_at);
      const pendingForMs = Number.isNaN(enqueuedAtMs)
        ? 0
        : Date.now() - enqueuedAtMs;
      if (pendingForMs < HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS) {
        return null;
      }
      return input.localHeuristicsProvider ?? null;
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

  // invariant: removes EDGE_CLASSIFY / POST_TURN_EXTRACT pending rows older
  // than HOST_WORKER_TASK_TTL_MS so a no-agent deployment's host-worker queue
  // cannot grow unbounded (the
  // heuristic edge / extract already stands; the stale LLM-refinement task is
  // dead weight). Each removal emits a SOUL_GARDEN_TASK_EXPIRED audit so the
  // delete is never silent. CAS-gated on status='pending' in the repo, so a task
  // a worker claimed between peek and delete is left intact. Runs on the same
  // ~60s pass as reclaimAbandonedGardenClaims; bounded per kind.
  // see also: packages/storage/src/repos/garden-task-repo.ts peekExpiredUnclaimedTasks
  // see also: packages/storage/src/repos/garden-task-repo.ts expireUnclaimedTasks
  const expireUnclaimedHostWorkerTasks = async (repo: SqliteGardenTaskRepo): Promise<void> => {
    const occurredAt = new Date().toISOString();
    const expiredBeforeIso = new Date(Date.now() - HOST_WORKER_TASK_TTL_MS).toISOString();
    for (const kind of HOST_WORKER_TTL_TASK_KINDS) {
      const expiredRows = repo.peekExpiredUnclaimedTasks(
        kind,
        expiredBeforeIso,
        HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS
      );
      if (expiredRows.length === 0) {
        continue;
      }
      const expirations: GardenTaskExpiryInput[] = expiredRows.map((row) => ({
        task_id: row.id,
        event: {
          event_type: GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
          entity_type: "garden_task",
          entity_id: row.id,
          workspace_id: row.workspace_id,
          run_id: extractGardenTaskRunId(row.payload),
          caused_by: "garden-runtime",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_EXPIRED, {
            task_id: row.id,
            task_kind: row.kind,
            role: row.role,
            tier: GARDEN_ROLE_TIER_MAP[row.role],
            workspace_id: row.workspace_id,
            run_id: extractGardenTaskRunId(row.payload),
            enqueued_at: row.created_at,
            ttl_ms: HOST_WORKER_TASK_TTL_MS,
            occurred_at: occurredAt
          })
        }
      }));
      const removed = await repo.expireUnclaimedTasks(expirations);
      if (removed > 0) {
        warn("expired never-claimed host-worker garden tasks past TTL", {
          task_kind: kind,
          removed,
          ttl_ms: HOST_WORKER_TASK_TTL_MS
        });
      }
    }
  };

  // invariant: enrich_pending crash-recovery sweep. A row claimed by a
  // BULK_ENRICH cycle that died before markProcessed is stranded (claimable
  // requires claimed_at IS NULL); after the TTL it is re-armed so a later cycle
  // re-drains it — no enrichment is silently lost on a daemon restart. Runs on
  // the same ~60s GardenScheduler pass as reclaimAbandonedGardenClaims.
  // see also: packages/storage/src/repos/enrich-pending-repo.ts reclaimStale
  const reclaimStaleEnrichClaims = (): void => {
    const enrichPendingRepo = input.enrichPendingRepo;
    if (enrichPendingRepo === undefined) {
      return;
    }
    enrichPendingRepo.reclaimStale(
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms
    );
  };

  // invariant: accept->mint crash-window reconcile sweep. Re-drives owed path
  // mints (bounded, oldest-first) for accepted/auto_accepted proposals stranded
  // without a path by a crash between the accept commit and the mint. Idempotent
  // via path dedup. Runs on the same ~60s pass as reclaimStaleEnrichClaims and
  // reclaimAbandonedGardenClaims. LOGs a per-workspace tally whenever it acted on
  // any row (no silent cap).
  // see also: packages/core/src/path-graph/edge-proposal-service.ts reconcileStuckAccepts.
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
          warn("edge proposal accept->mint reconcile pass acted on stranded accepts", {
            workspace_id: workspace.workspace_id,
            scanned: result.scanned,
            reminted: result.reminted,
            already_present: result.already_present,
            rejected: result.rejected,
            transient_failed: result.transient_failed
          });
        }
      } catch (error) {
        warn("edge proposal accept->mint reconcile pass failed; continuing", {
          workspace_id: workspace.workspace_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };

  // invariant: B5(a) edge-proposal TTL expiry sweep. Flips past-TTL pending
  // proposals to terminal `expired` (audited) per workspace, bounded per pass,
  // so an unreviewed backlog cannot grow unbounded on a no-reviewer deployment.
  // Runs on the same ~60s pass as reconcileStuckEdgeProposalAccepts. LOGs a
  // per-workspace tally whenever it expired any row.
  // see also: packages/core/src/path-graph/edge-proposal-service.ts sweepExpired.
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
          warn("edge proposal TTL sweep expired past-TTL pending proposals", {
            workspace_id: workspace.workspace_id,
            scanned: result.scanned,
            expired: result.expired,
            skipped: result.skipped
          });
        }
      } catch (error) {
        warn("edge proposal TTL sweep failed; continuing", {
          workspace_id: workspace.workspace_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
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
        // apps/core-daemon/src/forget-disposition-ports.ts computeForgetDisposition.
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
          await reclaimAbandonedGardenClaims(gardenTaskRepo);
          await expireUnclaimedHostWorkerTasks(gardenTaskRepo);
        }
        reclaimStaleEnrichClaims();
        await reconcileStuckEdgeProposalAccepts();
        // B5(a): expire past-TTL pending edge proposals so the unreviewed
        // backlog cannot grow unbounded on a no-reviewer deployment.
        await sweepExpiredEdgeProposals();
        await processPostTurnExtractTask();
        // invariant: drain enrich_pending on the ~60s cadence (not the 15-min
        // Librarian pass) so conflict-suppression edges form within a ~1-min
        // best-effort-eventual bound. The unconditional drain covers slow drip;
        // the threshold trigger below covers bursts. Both enqueue only when
        // there is something to drain, so a 60s all-workspace check is near-free.
        const bulkEnrichEnqueuedThisPass = new Set<string>();
        await enqueueBulkEnrichForAllWorkspaces(bulkEnrichEnqueuedThisPass);
        await enqueueBulkEnrichForCountThreshold(bulkEnrichEnqueuedThisPass);
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
          await runBulkEnrichTask(bulkEnrichTask);
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

          if (task.task_kind === GardenTaskKind.BULK_ENRICH) {
            await runBulkEnrichTask(task);
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
    // invariant: targeted embedding-backfill drain for a single workspace,
    // bypassing the full Garden background pass. Enqueues and dispatches ONLY
    // GardenTaskKind.EMBEDDING_BACKFILL for the requested workspace — the
    // dispatch passes workspaceId so the scheduler's pending peek is scoped to
    // it and a same-kind task queued for another workspace is never drained
    // here. Never BULK_ENRICH, MERGE_PROPOSAL,
    // PATH_PLASTICITY_UPDATE, PATH_GRAPH_SNAPSHOT, CONSOLIDATION_CYCLE,
    // post-turn extract, Janitor, or Auditor work. Does NOT call
    // markBackgroundPassCompleted(): this is a recall-readiness drain, not a
    // Garden maintenance cadence tick, so it must not advance last_pass_at.
    // Reuses runEmbeddingBackfillTask; its O(n) handle() drains the whole
    // workspace hot corpus in one call. The dispatch loop is bounded so a
    // stuck/failing task cannot spin forever.
    // see also: enqueueEmbeddingBackfillForAllWorkspaces, runEmbeddingBackfillTask.
    runEmbeddingBackfillPass: async (workspaceId: string) => {
      if (input.embeddingBackfillHandler === undefined) {
        return;
      }

      let dispatchedCount = 0;
      let lastTargetedReason: string | null = null;

      for (
        let drained = 0;
        drained < EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS;
        drained += 1
      ) {
        const task = await runtimeGardenScheduler.dispatchNextMatchingTaskKind(
          GardenRole.LIBRARIAN,
          [GardenTaskKind.EMBEDDING_BACKFILL],
          workspaceId
        );
        requestBacklogTelemetryCapture("warmup:embedding_backfill");
        if (task === null) {
          break;
        }

        dispatchedCount += 1;
        const outcome = await runEmbeddingBackfillTask(task);
        lastTargetedReason = summarizeEmbeddingBackfillTargetedReason(outcome) ?? lastTargetedReason;
      }

      // invariant: the await above opens a check-then-add TOCTOU window on
      // pendingEmbeddingBackfillWorkspaces, but it is harmless — every caller
      // runs these passes strictly sequentially per workspace (awaited per
      // question), so two concurrent same-workspace passes never occur; and even
      // if they did, a duplicate EMBEDDING_BACKFILL task is idempotent (the
      // handler cache-hits every row via the content-hash CAS — no double-spend,
      // no corruption). No lock machinery is warranted for a window that cannot
      // occur. see also: packages/core/src/embedding-recall/embedding-backfill-handler.ts
      if (dispatchedCount === 0 && !pendingEmbeddingBackfillWorkspaces.has(workspaceId)) {
        pendingEmbeddingBackfillWorkspaces.add(workspaceId);
        gardenScheduler.enqueue({
          task_id: randomUUID(),
          task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
          required_tier: GardenTier.TIER_2,
          workspace_id: workspaceId,
          run_id: null,
          target_object_refs: [workspaceId],
          priority: 10,
          created_at: new Date().toISOString()
        });
        requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);

        for (
          let drained = 0;
          drained < EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS;
          drained += 1
        ) {
          const task = await runtimeGardenScheduler.dispatchNextMatchingTaskKind(
            GardenRole.LIBRARIAN,
            [GardenTaskKind.EMBEDDING_BACKFILL],
            workspaceId
          );
          requestBacklogTelemetryCapture("warmup:embedding_backfill");
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
