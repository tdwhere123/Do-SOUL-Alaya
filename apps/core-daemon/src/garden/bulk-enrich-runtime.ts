import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type CandidateMemorySignal,
  type EventType,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import type { SqliteGardenTaskRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";

export interface BulkEnrichRuntimeSupport {
  enqueueForAllWorkspaces(enqueuedThisPass: Set<string>): Promise<void>;
  enqueueForCountThreshold(enqueuedThisPass: Set<string>): Promise<void>;
  reclaimStaleClaims(): void;
  runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
}

export function createBulkEnrichRuntimeSupport(input: Readonly<{
  readonly enrichPendingRepo?: {
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
  };
  readonly enrichMemoryLookup?: {
    findById(memoryId: string): Promise<
      | Readonly<{
          readonly object_id: string;
          readonly dimension: string;
          readonly scope_class: string;
          readonly content: string;
          readonly domain_tags: readonly string[];
          readonly workspace_id: string;
          readonly run_id: string | null;
        }>
      | null
    >;
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
      readonly signal: Readonly<CandidateMemorySignal>;
    }): Promise<void>;
  };
  readonly eventPublisher: EventPublisher;
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
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly onTaskEnqueued: (reason: string) => void;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}>): BulkEnrichRuntimeSupport {
  const bulkEnrichWired =
    input.enrichPendingRepo !== undefined &&
    input.enrichMemoryLookup !== undefined &&
    (input.enrichEdgeProducerPort !== undefined ||
      input.enrichConflictDetectionPort !== undefined ||
      input.enrichSignalRefReplayPort !== undefined);

  const enqueueForWorkspace = (workspaceId: string, nowIso: string): void => {
    input.gardenScheduler.enqueue({
      task_id: randomUUID(),
      task_kind: GardenTaskKind.BULK_ENRICH,
      required_tier: GardenTier.TIER_2,
      workspace_id: workspaceId,
      run_id: null,
      target_object_refs: [workspaceId],
      priority: 10,
      created_at: nowIso
    });
    input.onTaskEnqueued(`enqueue:${GardenTaskKind.BULK_ENRICH}`);
  };

  const hasQueuedTask = (
    workspaceId: string,
    enqueuedThisPass: ReadonlySet<string>
  ): boolean =>
    enqueuedThisPass.has(workspaceId) ||
    (input.gardenTaskRepo
      ?.peekPending(GardenRole.LIBRARIAN, workspaceId, 50)
      .some((candidate) => candidate.kind === GardenTaskKind.BULK_ENRICH) ??
      false);

  const enqueueForAllWorkspaces = async (enqueuedThisPass: Set<string>): Promise<void> => {
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
      if (hasQueuedTask(workspace.workspace_id, enqueuedThisPass)) {
        continue;
      }
      enqueueForWorkspace(workspace.workspace_id, nowIso);
      enqueuedThisPass.add(workspace.workspace_id);
    }
  };

  const enqueueForCountThreshold = async (enqueuedThisPass: Set<string>): Promise<void> => {
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
      if (hasQueuedTask(workspace.workspace_id, enqueuedThisPass)) {
        continue;
      }
      enqueueForWorkspace(workspace.workspace_id, nowIso);
      enqueuedThisPass.add(workspace.workspace_id);
    }
  };

  const reclaimStaleClaims = (): void => {
    const enrichPendingRepo = input.enrichPendingRepo;
    if (enrichPendingRepo === undefined) {
      return;
    }
    enrichPendingRepo.reclaimStale(
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms
    );
  };

  const runTask = async (task: Readonly<GardenTaskDescriptor>): Promise<void> => {
    const completedAt = new Date().toISOString();
    const enrichPendingRepo = input.enrichPendingRepo;
    const memoryLookup = input.enrichMemoryLookup;
    const edgeProducer = input.enrichEdgeProducerPort;
    const conflictDetection = input.enrichConflictDetectionPort;
    const signalLookup = input.enrichSourceSignalLookup;
    const signalRefReplay = input.enrichSignalRefReplayPort;
    if (enrichPendingRepo === undefined || memoryLookup === undefined) {
      await reportCompletion(task, completedAt, true, [
        "bulk_enrich_skipped:no_enrich_pending_table"
      ]);
      return;
    }
    if (edgeProducer === undefined && conflictDetection === undefined && signalRefReplay === undefined) {
      await reportCompletion(task, completedAt, true, [
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
              strictNoDrop: true
            });
          }
          enrichPendingRepo.markProcessed(pending.workspaceId, pending.memoryId, completedAt);
          processedCount += 1;
        } catch (memoryError) {
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
            input.warn("bulk enrich memory abandoned after exhausting retries; dead-lettered", {
              workspace_id: pending.workspaceId,
              memory_id: pending.memoryId,
              source_signal_id: pending.sourceSignalId,
              attempt_count: outcome.attemptCount,
              max_attempts: DYNAMICS_CONSTANTS.enrich.max_attempts,
              error: failureKind
            });
          } else {
            input.warn("bulk enrich memory failed; released claim for retry", {
              workspace_id: pending.workspaceId,
              memory_id: pending.memoryId,
              attempt_count: outcome.attemptCount,
              error: failureKind
            });
          }
        }
      }

      await reportCompletion(task, completedAt, true, [
        `bulk_enrich:processed_${processedCount}`,
        `bulk_enrich:missing_${missingCount}`,
        `bulk_enrich:failed_${failedCount}`,
        `bulk_enrich:abandoned_${abandonedCount}`
      ]);
    } catch (error) {
      await reportCompletion(task, completedAt, false, [], error);
      input.warn("bulk enrich task failed; continuing Garden background pass", {
        workspace_id: task.workspace_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

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

  const reportCompletion = async (
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

  return {
    enqueueForAllWorkspaces,
    enqueueForCountThreshold,
    reclaimStaleClaims,
    runTask
  };
}
