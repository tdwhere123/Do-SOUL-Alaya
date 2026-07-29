import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import type { SqliteGardenTaskRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";

export type BulkEnrichPendingClaim = Readonly<{
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly runId: string | null;
  readonly sourceSignalId: string | null;
}>;

type BulkEnrichMemoryRecord = Readonly<{
  readonly object_id: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string | null;
}>;

type BulkEnrichSchedulerPort = Readonly<{
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
}>;

export type CreateBulkEnrichRuntimeSupportInput = Readonly<{
  readonly enrichPendingRepo?: {
    claimBatch(
      workspaceId: string,
      limit: number,
      claimedAt: string,
      maxAttempts: number
    ): readonly BulkEnrichPendingClaim[];
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
  };
  readonly enrichMemoryLookup?: {
    findById(memoryId: string): Promise<BulkEnrichMemoryRecord | null>;
  };
  readonly enrichConflictDetectionPort?: {
    detectAndLinkConflicts(input: {
      readonly newMemoryId: string;
      readonly newMemoryDimension: string;
      readonly newMemoryScopeClass: string;
      readonly newMemoryContent: string;
      readonly newMemoryDomainTags: readonly string[];
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly strictNoDrop?: boolean;
    }): Promise<void>;
  };
  readonly enrichEdgeProducerPort?: {
    produceForNewMemory(input: {
      readonly newMemoryId: string;
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly sourceSignalId: string;
    }): Promise<void>;
  };
  readonly enrichSourceSignalLookup?: {
    getById(signalId: string): Promise<Readonly<CandidateMemorySignal> | null>;
  };
  readonly enrichSignalRefReplayPort?: {
    replaySignalRefs(input: {
      readonly newMemoryId: string;
      readonly memoryEvidenceIds: readonly string[];
      readonly signal: Readonly<CandidateMemorySignal>;
    }): Promise<void>;
  };
  readonly eventPublisher: EventPublisher;
  readonly gardenScheduler: BulkEnrichSchedulerPort;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly onTaskEnqueued: (reason: string) => void;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}>;

export type BulkEnrichReadyPorts = Readonly<{
  readonly enrichPendingRepo: NonNullable<CreateBulkEnrichRuntimeSupportInput["enrichPendingRepo"]>;
  readonly memoryLookup: NonNullable<CreateBulkEnrichRuntimeSupportInput["enrichMemoryLookup"]>;
  readonly edgeProducer: CreateBulkEnrichRuntimeSupportInput["enrichEdgeProducerPort"];
  readonly conflictDetection: CreateBulkEnrichRuntimeSupportInput["enrichConflictDetectionPort"];
  readonly signalLookup: CreateBulkEnrichRuntimeSupportInput["enrichSourceSignalLookup"];
  readonly signalRefReplay: CreateBulkEnrichRuntimeSupportInput["enrichSignalRefReplayPort"];
}>;

export type BulkEnrichAvailability =
  | Readonly<{ readonly kind: "missing_repo" }>
  | Readonly<{ readonly kind: "disabled" }>
  | Readonly<{ readonly kind: "ready"; readonly ports: BulkEnrichReadyPorts }>;

export function resolveBulkEnrichAvailability(
  input: CreateBulkEnrichRuntimeSupportInput
): BulkEnrichAvailability {
  if (input.enrichPendingRepo === undefined || input.enrichMemoryLookup === undefined) {
    return { kind: "missing_repo" };
  }
  if (
    input.enrichEdgeProducerPort === undefined &&
    input.enrichConflictDetectionPort === undefined &&
    input.enrichSignalRefReplayPort === undefined
  ) {
    return { kind: "disabled" };
  }
  return {
    kind: "ready",
    ports: {
      enrichPendingRepo: input.enrichPendingRepo,
      memoryLookup: input.enrichMemoryLookup,
      edgeProducer: input.enrichEdgeProducerPort,
      conflictDetection: input.enrichConflictDetectionPort,
      signalLookup: input.enrichSourceSignalLookup,
      signalRefReplay: input.enrichSignalRefReplayPort
    }
  };
}

export function createBulkEnrichWorkspaceQueue(input: Readonly<{
  readonly availability: BulkEnrichAvailability;
  readonly gardenScheduler: BulkEnrichSchedulerPort;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly onTaskEnqueued: (reason: string) => void;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}>): Readonly<{
  enqueueForAllWorkspaces(enqueuedThisPass: Set<string>): Promise<void>;
  enqueueForCountThreshold(enqueuedThisPass: Set<string>): Promise<void>;
}> {
  return {
    enqueueForAllWorkspaces: async (enqueuedThisPass) =>
      await enqueueMatchingBulkEnrichWorkspaces(
        input,
        enqueuedThisPass,
        (_workspaceId, pendingCount) => pendingCount > 0
      ),
    enqueueForCountThreshold: async (enqueuedThisPass) =>
      await enqueueMatchingBulkEnrichWorkspaces(
        input,
        enqueuedThisPass,
        (_workspaceId, pendingCount) =>
          pendingCount >= DYNAMICS_CONSTANTS.enrich.batch_trigger_count
      )
  };
}

async function enqueueMatchingBulkEnrichWorkspaces(
  input: Readonly<{
    readonly availability: BulkEnrichAvailability;
    readonly gardenScheduler: BulkEnrichSchedulerPort;
    readonly gardenTaskRepo?: SqliteGardenTaskRepo;
    readonly onTaskEnqueued: (reason: string) => void;
    readonly workspaceRepo: SqliteWorkspaceRepo;
  }>,
  enqueuedThisPass: Set<string>,
  shouldEnqueue: (workspaceId: string, pendingCount: number) => boolean
): Promise<void> {
  if (input.availability.kind !== "ready") {
    return;
  }
  const workspaces = await input.workspaceRepo.list();
  const nowIso = new Date().toISOString();
  for (const workspace of workspaces) {
    const pendingCount = input.availability.ports.enrichPendingRepo.countPending(workspace.workspace_id);
    if (!shouldEnqueue(workspace.workspace_id, pendingCount)) {
      continue;
    }
    if (hasQueuedBulkEnrichTask(input.gardenTaskRepo, workspace.workspace_id, enqueuedThisPass)) {
      continue;
    }
    enqueueBulkEnrichWorkspace(input.gardenScheduler, input.onTaskEnqueued, workspace.workspace_id, nowIso);
    enqueuedThisPass.add(workspace.workspace_id);
  }
}

function hasQueuedBulkEnrichTask(
  gardenTaskRepo: SqliteGardenTaskRepo | undefined,
  workspaceId: string,
  enqueuedThisPass: ReadonlySet<string>
): boolean {
  return enqueuedThisPass.has(workspaceId) ||
    (gardenTaskRepo
      ?.peekPending(GardenRole.LIBRARIAN, workspaceId, 50)
      .some((candidate) => candidate.kind === GardenTaskKind.BULK_ENRICH) ?? false);
}

function enqueueBulkEnrichWorkspace(
  gardenScheduler: BulkEnrichSchedulerPort,
  onTaskEnqueued: (reason: string) => void,
  workspaceId: string,
  nowIso: string
): void {
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
  onTaskEnqueued(`enqueue:${GardenTaskKind.BULK_ENRICH}`);
}
