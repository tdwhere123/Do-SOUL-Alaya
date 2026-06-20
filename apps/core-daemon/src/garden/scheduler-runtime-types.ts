import type {
  GardenTaskDescriptor,
  GardenTaskKindValue,
  GardenTierValue,
  SoulConfig
} from "@do-soul/alaya-protocol";
import type { EmbeddingBackfillHandler, EventPublisher } from "@do-soul/alaya-core";
import type {
  PathPlasticityWatermarkRepo,
  SqlitePathGraphSnapshotRepo,
  SqlitePathRelationRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import type {
  AuditorSchedulingAdvisor,
  ConsolidationExecutor
} from "@do-soul/alaya-core";

export type EmbeddingBackfillTaskOutcome = Readonly<{
  readonly success: boolean;
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
  readonly errorMessage: string | null;
}>;

export type RuntimeGardenScheduler = {
  dispatchNextMatchingTaskKind(
    role: string,
    taskKinds: readonly GardenTaskKindValue[],
    workspaceId?: string
  ): Promise<Readonly<GardenTaskDescriptor> | null>;
};

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

export type CreateGardenSchedulerRuntimeSupportInput = Readonly<{
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
}>;
