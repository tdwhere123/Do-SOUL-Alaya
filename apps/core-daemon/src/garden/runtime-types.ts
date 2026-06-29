import type {
  GardenBacklogThresholds,
  GardenTaskKindValue,
  GardenTierValue,
  HealthIssueCauseKindValue,
  HealthIssueGroup,
  RuntimeGardenComputeConfig,
  CandidateMemorySignal,
  SoulConfig
} from "@do-soul/alaya-protocol";
import type {
  EmbeddingBackfillHandler,
  EventPublisher,
  PathPlasticityService,
  StrongRefService
} from "@do-soul/alaya-core";
import type {
  createGardenBackgroundDataPorts,
  PathPlasticityWatermarkRepo,
  SqliteEventLogRepo,
  SqliteHandoffGapRepo,
  SqliteHealthJournalRepo,
  SqliteOrphanRadarRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteWorkspaceRepo,
  StorageDatabase
} from "@do-soul/alaya-storage";
import type {
  GardenComputeProvider,
  GardenScheduler,
  JanitorDispositionSweepPort,
  JanitorTombstoneGcPort
} from "@do-soul/alaya-soul";
import type { BackgroundServiceManager } from "../background/bootstrap.js";

export type RuntimeGardenScheduler = GardenScheduler & {
  dispatchNextMatchingTaskKind(
    role: Parameters<GardenScheduler["dispatchNext"]>[0],
    taskKinds: readonly GardenTaskKindValue[],
    workspaceId?: string
  ): ReturnType<GardenScheduler["dispatchNext"]>;
};

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

export interface BulkEnrichPendingPort {
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

export interface BulkEnrichMemoryLookupPort {
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

export interface BulkEnrichConflictDetectionPort {
  detectAndLinkConflicts(params: {
    readonly newMemoryId: string;
    readonly newMemoryDimension: string;
    readonly newMemoryScopeClass: string;
    readonly newMemoryContent: string;
    readonly newMemoryDomainTags: readonly string[];
    readonly workspaceId: string;
    readonly runId: string;
    readonly strictNoDrop?: boolean;
  }): Promise<void>;
}

export interface BulkEnrichEdgeProducerPort {
  produceForNewMemory(params: {
    readonly newMemoryId: string;
    readonly workspaceId: string;
    readonly runId: string;
    readonly sourceSignalId: string;
  }): Promise<void>;
}

export interface BulkEmbeddingCoherencePort {
  crystallizeForBackfill(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
  }): Promise<{ readonly minted: number }>;
}

export interface BulkEnrichSourceSignalLookupPort {
  getById(signalId: string): Promise<CandidateMemorySignal | null>;
}

export interface BulkEnrichSignalRefReplayPort {
  replaySignalRefs(params: {
    readonly newMemoryId: string;
    readonly signal: CandidateMemorySignal;
  }): Promise<void>;
}

export interface EdgeProposalReconcilePort {
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
  sweepExpired(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<{
    readonly scanned: number;
    readonly expired: number;
    readonly skipped: number;
  }>;
}

export type CreateGardenRuntimeInput = {
  readonly databaseConnection: StorageDatabase["connection"];
  readonly backlogThresholds: GardenBacklogThresholds;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly gardenDataPorts: ReturnType<typeof createGardenBackgroundDataPorts>;
  readonly healthJournalRepo: SqliteHealthJournalRepo;
  readonly handoffGapRepo: SqliteHandoffGapRepo;
  readonly orphanDetectionEnabled: boolean;
  readonly orphanRadarRepo: SqliteOrphanRadarRepo | null;
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
  readonly coherenceEdgeProducerPort?: BulkEmbeddingCoherencePort;
  readonly answersWithEdgeProducerPort?: BulkEmbeddingCoherencePort;
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
  readonly tombstoneDispositionSweepPort?: JanitorDispositionSweepPort;
  readonly tombstoneGcPort?: JanitorTombstoneGcPort;
  readonly enrichPendingRepo?: BulkEnrichPendingPort;
  readonly enrichMemoryLookup?: BulkEnrichMemoryLookupPort;
  readonly enrichConflictDetectionPort?: BulkEnrichConflictDetectionPort;
  readonly enrichEdgeProducerPort?: BulkEnrichEdgeProducerPort;
  readonly enrichSourceSignalLookup?: BulkEnrichSourceSignalLookupPort;
  readonly enrichSignalRefReplayPort?: BulkEnrichSignalRefReplayPort;
  readonly edgeProposalReconcile?: EdgeProposalReconcilePort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
};

export type GardenRuntime = Readonly<{
  readonly backgroundManager: BackgroundServiceManager;
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  getStatus(): GardenRuntimeStatus;
  runEventLogOrphanDetection(): Promise<void>;
  runBackgroundPass(): Promise<void>;
  runBulkEnrichPass(workspaceId: string): Promise<void>;
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}>;
