import {
  DYNAMICS_CONSTANTS,
  GardenEventType,
  GardenRole,
  GardenTier,
  parseGardenEventPayload,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import type {
  BulkEnrichAvailability,
  BulkEnrichPendingClaim,
  BulkEnrichReadyPorts
} from "./bulk-enrich-runtime-helpers.js";

type BulkEnrichReporter = Readonly<{
  emitEnrichAbandoned(
    pending: BulkEnrichPendingClaim,
    attemptCount: number,
    lastFailureKind: string,
    occurredAt: string
  ): Promise<void>;
  reportCompletion(
    task: Readonly<GardenTaskDescriptor>,
    completedAt: string,
    success: boolean,
    auditEntries: readonly string[],
    error?: unknown
  ): Promise<void>;
  warn(message: string, meta: Record<string, unknown>): void;
}>;

export function createBulkEnrichReporter(input: Readonly<{
  readonly eventPublisher: EventPublisher;
  readonly gardenScheduler: {
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
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): BulkEnrichReporter {
  return {
    emitEnrichAbandoned: async (pending, attemptCount, lastFailureKind, occurredAt) => {
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
    },
    reportCompletion: async (task, completedAt, success, auditEntries, error) => {
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
    },
    warn: input.warn
  };
}

export async function runBulkEnrichTask(input: Readonly<{
  readonly task: Readonly<GardenTaskDescriptor>;
  readonly availability: BulkEnrichAvailability;
  readonly reporter: BulkEnrichReporter;
}>): Promise<void> {
  const completedAt = new Date().toISOString();
  if (input.availability.kind === "missing_repo") {
    await input.reporter.reportCompletion(input.task, completedAt, true, [
      "bulk_enrich_skipped:no_enrich_pending_table"
    ]);
    return;
  }
  if (input.availability.kind === "disabled") {
    await input.reporter.reportCompletion(input.task, completedAt, true, [
      "bulk_enrich_skipped:enrichment_disabled"
    ]);
    return;
  }

  try {
    const claimed = claimBulkEnrichBatch(
      input.availability.ports.enrichPendingRepo,
      input.task.workspace_id,
      completedAt
    );
    const summary = await processClaimedBatch(
      claimed,
      completedAt,
      input.availability.ports,
      input.reporter
    );
    await input.reporter.reportCompletion(input.task, completedAt, true, summarizeClaimedBatch(summary));
  } catch (error) {
    await input.reporter.reportCompletion(input.task, completedAt, false, [], error);
    input.reporter.warn("bulk enrich task failed; continuing Garden background pass", {
      workspace_id: input.task.workspace_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function runClaimableBulkEnrichWorkspacePass(input: Readonly<{
  readonly availability: BulkEnrichAvailability;
  readonly workspaceId: string;
  readonly maxBatches: number;
  readonly reporter: BulkEnrichReporter;
}>): Promise<void> {
  if (input.availability.kind !== "ready") {
    return;
  }

  for (let batch = 0; batch < input.maxBatches; batch += 1) {
    const processedAt = new Date().toISOString();
    const claimed = claimBulkEnrichBatch(
      input.availability.ports.enrichPendingRepo,
      input.workspaceId,
      processedAt
    );
    if (claimed.length === 0) {
      break;
    }
    await processClaimedBatch(
      claimed,
      processedAt,
      input.availability.ports,
      input.reporter
    );
    if (claimed.length < DYNAMICS_CONSTANTS.enrich.claim_batch_size) {
      break;
    }
  }
}

function claimBulkEnrichBatch(
  enrichPendingRepo: BulkEnrichReadyPorts["enrichPendingRepo"],
  workspaceId: string,
  claimedAt: string
): readonly BulkEnrichPendingClaim[] {
  return enrichPendingRepo.claimBatch(
    workspaceId,
    DYNAMICS_CONSTANTS.enrich.claim_batch_size,
    claimedAt,
    DYNAMICS_CONSTANTS.enrich.max_attempts
  );
}

async function processClaimedBatch(
  claimed: readonly BulkEnrichPendingClaim[],
  processedAt: string,
  ports: BulkEnrichReadyPorts,
  reporter: BulkEnrichReporter
): Promise<Readonly<{
  readonly processedCount: number;
  readonly missingCount: number;
  readonly failedCount: number;
  readonly abandonedCount: number;
}>> {
  let processedCount = 0;
  let missingCount = 0;
  let failedCount = 0;
  let abandonedCount = 0;

  for (const pending of claimed) {
    try {
      const memory = await ports.memoryLookup.findById(pending.memoryId);
      if (memory === null) {
        ports.enrichPendingRepo.delete(pending.workspaceId, pending.memoryId);
        missingCount += 1;
        continue;
      }
      await replayBulkEnrichSignalRefs(pending, memory.object_id, memory.evidence_refs, ports);
      await produceBulkEnrichEdges(pending, memory, ports);
      await detectBulkEnrichConflicts(memory, ports);
      ports.enrichPendingRepo.markProcessed(pending.workspaceId, pending.memoryId, processedAt);
      processedCount += 1;
    } catch (error) {
      failedCount += 1;
      const abandoned = await handleBulkEnrichFailure(
        pending,
        processedAt,
        error,
        ports.enrichPendingRepo,
        reporter
      );
      if (abandoned) {
        abandonedCount += 1;
      }
    }
  }

  return {
    processedCount,
    missingCount,
    failedCount,
    abandonedCount
  };
}

async function replayBulkEnrichSignalRefs(
  pending: BulkEnrichPendingClaim,
  memoryId: string,
  evidenceIds: readonly string[],
  ports: BulkEnrichReadyPorts
): Promise<void> {
  if (ports.signalRefReplay === undefined || pending.sourceSignalId === null) {
    return;
  }
  if (ports.signalLookup === undefined) {
    throw new Error("BULK_ENRICH signal-ref replay is wired without a source signal lookup port.");
  }
  const sourceSignal = await ports.signalLookup.getById(pending.sourceSignalId);
  if (sourceSignal === null) {
    throw new Error(
      `BULK_ENRICH signal-ref replay could not load source signal ${pending.sourceSignalId}.`
    );
  }
  await ports.signalRefReplay.replaySignalRefs({
    newMemoryId: memoryId,
    memoryEvidenceIds: evidenceIds,
    signal: sourceSignal
  });
}

async function produceBulkEnrichEdges(
  pending: BulkEnrichPendingClaim,
  memory: Awaited<ReturnType<BulkEnrichReadyPorts["memoryLookup"]["findById"]>> & {
    readonly object_id: string;
    readonly workspace_id: string;
    readonly run_id: string | null;
  },
  ports: BulkEnrichReadyPorts
): Promise<void> {
  if (ports.edgeProducer === undefined) {
    return;
  }
  await ports.edgeProducer.produceForNewMemory({
    newMemoryId: memory.object_id,
    workspaceId: memory.workspace_id,
    runId: memory.run_id,
    sourceSignalId: pending.sourceSignalId ?? memory.object_id
  });
}

async function detectBulkEnrichConflicts(
  memory: Awaited<ReturnType<BulkEnrichReadyPorts["memoryLookup"]["findById"]>> & {
    readonly object_id: string;
    readonly dimension: string;
    readonly scope_class: string;
    readonly content: string;
    readonly domain_tags: readonly string[];
    readonly workspace_id: string;
    readonly run_id: string | null;
  },
  ports: BulkEnrichReadyPorts
): Promise<void> {
  if (ports.conflictDetection === undefined) {
    return;
  }
  await ports.conflictDetection.detectAndLinkConflicts({
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

async function handleBulkEnrichFailure(
  pending: BulkEnrichPendingClaim,
  processedAt: string,
  error: unknown,
  enrichPendingRepo: BulkEnrichReadyPorts["enrichPendingRepo"],
  reporter: BulkEnrichReporter
): Promise<boolean> {
  const failureKind = error instanceof Error ? error.message : String(error);
  const outcome = enrichPendingRepo.recordFailedAttempt(
    pending.workspaceId,
    pending.memoryId,
    DYNAMICS_CONSTANTS.enrich.max_attempts,
    processedAt
  );
  if (outcome.abandoned) {
    await reporter.emitEnrichAbandoned(pending, outcome.attemptCount, failureKind, processedAt);
    reporter.warn("bulk enrich memory abandoned after exhausting retries; dead-lettered", {
      workspace_id: pending.workspaceId,
      memory_id: pending.memoryId,
      source_signal_id: pending.sourceSignalId,
      attempt_count: outcome.attemptCount,
      max_attempts: DYNAMICS_CONSTANTS.enrich.max_attempts,
      error: failureKind
    });
    return true;
  }
  reporter.warn("bulk enrich memory failed; released claim for retry", {
    workspace_id: pending.workspaceId,
    memory_id: pending.memoryId,
    attempt_count: outcome.attemptCount,
    error: failureKind
  });
  return false;
}

function summarizeClaimedBatch(summary: Readonly<{
  readonly processedCount: number;
  readonly missingCount: number;
  readonly failedCount: number;
  readonly abandonedCount: number;
}>): readonly string[] {
  return [
    `bulk_enrich:processed_${summary.processedCount}`,
    `bulk_enrich:missing_${summary.missingCount}`,
    `bulk_enrich:failed_${summary.failedCount}`,
    `bulk_enrich:abandoned_${summary.abandonedCount}`
  ];
}
