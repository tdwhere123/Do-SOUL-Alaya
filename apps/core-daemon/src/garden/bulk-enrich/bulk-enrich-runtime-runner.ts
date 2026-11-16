import type { SourceEnrichmentCapability } from "./source-enrichment-runtime.js";
import {
  AlayaError,
  DYNAMICS_CONSTANTS,
  GardenEventType,
  GardenRole,
  GardenTier,
  gardenTaskOutcomeSuccess,
  parseGardenEventPayload,
  type GardenTaskOutcome,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { SignalService, type EventPublisher } from "@do-soul/alaya-core";
import {
  isPerSourceEnrichmentTask,
  type BulkEnrichAvailability,
  type BulkEnrichMemoryRecord,
  type BulkEnrichPendingClaim,
  type BulkEnrichReadyPorts,
  type BulkEnrichSchedulerPort,
  type CreateBulkEnrichRuntimeSupportInput
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
    outcome: GardenTaskOutcome,
    auditEntries: readonly string[],
    error?: unknown
  ): Promise<void>;
  warn(message: string, meta: Record<string, unknown>): void;
}>;

export function createBulkEnrichReporter(input: Readonly<{
  readonly eventPublisher: EventPublisher;
  readonly gardenScheduler: Pick<BulkEnrichSchedulerPort, "reportCompletion">;
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
    reportCompletion: async (task, completedAt, outcome, auditEntries, error) => {
      await input.gardenScheduler.reportCompletion({
        task_id: task.task_id,
        task_kind: task.task_kind,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        workspace_id: task.workspace_id,
        success: gardenTaskOutcomeSuccess(outcome),
        outcome,
        objects_affected: [],
        audit_entries: [...auditEntries],
        error_message: outcome !== "failed" ? null : error instanceof Error ? error.message : String(error),
        completed_at: completedAt
      });
    },
    warn: input.warn
  };
}

type BulkEnrichTaskInput = Readonly<{
  readonly now: () => string;
  readonly task: Readonly<GardenTaskDescriptor>;
  readonly availability: BulkEnrichAvailability;
  readonly reporter: BulkEnrichReporter;
  readonly sourceEnrichment?: CreateBulkEnrichRuntimeSupportInput["sourceEnrichment"];
}>;

export async function runBulkEnrichTask(input: BulkEnrichTaskInput): Promise<void> {
  const completedAt = input.now();
  if (isPerSourceEnrichmentTask(input.task)) {
    await runPerSourceEnrichmentTask(input, completedAt);
    return;
  }
  if (input.availability.kind === "missing_repo") {
    await input.reporter.reportCompletion(input.task, completedAt, "failed", [
      "bulk_enrich_failed:no_enrich_pending_table"
    ], new AlayaError("UNAVAILABLE", "bulk enrich pending table is not configured"));
    return;
  }
  if (input.availability.kind === "disabled") {
    await input.reporter.reportCompletion(input.task, completedAt, "skipped", [
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
    await input.reporter.reportCompletion(
      input.task,
      completedAt,
      summary.failed > 0 ? "failed" : "completed",
      summarizeClaimedBatch(summary),
      summary.failed > 0 ? new AlayaError("UNAVAILABLE", "bulk enrich batch has unfinished failed items") : undefined
    );
  } catch (error) {
    await input.reporter.reportCompletion(input.task, completedAt, "failed", [], error);
    input.reporter.warn("bulk enrich task failed; continuing Garden background pass", {
      workspace_id: input.task.workspace_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runPerSourceEnrichmentTask(
  input: Pick<BulkEnrichTaskInput, "task" | "reporter" | "sourceEnrichment">,
  completedAt: string
): Promise<void> {
  if (input.sourceEnrichment === undefined) {
    await input.reporter.reportCompletion(input.task, completedAt, "failed", [
      "source_enrich_unwired",
      ...sourceEnrichCapabilityEntries({
        configured: false,
        observationFamily: "none",
        requestBytes: "reserved",
        completionTokens: "unsupported",
        spend: "unsupported"
      })
    ], new AlayaError("UNAVAILABLE", "per-source enrichment worker is not composed"));
    return;
  }
  let outcome: string;
  try {
    outcome = await input.sourceEnrichment.run(input.task);
  } catch (error) {
    await input.reporter.reportCompletion(input.task, completedAt, "failed", [], error);
    input.reporter.warn("per-source enrichment failed; continuing Garden background pass", {
      workspace_id: input.task.workspace_id,
      task_id: input.task.task_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }
  if (outcome === "uncertain" || outcome === "busy" || outcome === "work_busy" ||
      (input.sourceEnrichment.ownsCompletion === true && outcome !== "missing")) return;
  const success = outcome === "completed";
  await input.reporter.reportCompletion(
    input.task,
    completedAt,
    success ? "completed" : "failed",
    [`source_enrich:${outcome}`, ...sourceEnrichCapabilityEntries(input.sourceEnrichment.capability)],
    success ? undefined : new AlayaError("UNAVAILABLE", outcome)
  );
}

function sourceEnrichCapabilityEntries(capability: SourceEnrichmentCapability | undefined): readonly string[] {
  if (capability === undefined) return [];
  return [
    `source_enrich_capability:${capability.configured ? "configured" : "unconfigured"}`,
    `source_enrich_spend:${capability.spend}`,
    `source_enrich_completion_tokens:${capability.completionTokens}`,
    `source_enrich_family:${capability.observationFamily}`
  ];
}

export async function runClaimableBulkEnrichWorkspacePass(input: Readonly<{
  readonly now: () => string;
  readonly availability: BulkEnrichAvailability;
  readonly workspaceId: string;
  readonly maxBatches: number;
  readonly reporter: BulkEnrichReporter;
}>): Promise<void> {
  if (input.availability.kind !== "ready") {
    return;
  }

  for (let batch = 0; batch < input.maxBatches; batch += 1) {
    const processedAt = input.now();
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
    DYNAMICS_CONSTANTS.enrich.max_attempts,
    SignalService.referenceReplayReadyState
  );
}

type BulkEnrichBatchSummary = Readonly<{
  processed: number;
  missing: number;
  failed: number;
  abandoned: number;
  withheld: number;
}>;

async function processClaimedBatch(
  claimed: readonly BulkEnrichPendingClaim[],
  processedAt: string,
  ports: BulkEnrichReadyPorts,
  reporter: BulkEnrichReporter
): Promise<BulkEnrichBatchSummary> {
  const summary = { processed: 0, missing: 0, failed: 0, abandoned: 0, withheld: 0 };
  for (const pending of claimed) {
    try {
      const outcome = await processClaimedMemory(pending, processedAt, ports);
      summary[outcome] += 1;
    } catch (error) {
      summary.failed += 1;
      const abandoned = await handleBulkEnrichFailure(
        pending,
        processedAt,
        error,
        ports.enrichPendingRepo,
        reporter
      );
      if (abandoned) {
        summary.abandoned += 1;
      }
    }
  }
  return summary;
}

async function processClaimedMemory(
  pending: BulkEnrichPendingClaim,
  processedAt: string,
  ports: BulkEnrichReadyPorts
): Promise<"processed" | "missing" | "withheld"> {
  const memory = await ports.memoryLookup.findById(pending.memoryId);
  if (memory === null) {
    ports.enrichPendingRepo.delete(pending.workspaceId, pending.memoryId);
    return "missing";
  }
  if (memory.workspace_id !== pending.workspaceId) {
    throw new AlayaError("CONFLICT", "BULK_ENRICH memory workspace does not match its obligation.");
  }
  if (pending.independentProcessedAt == null) {
    await processIndependentEnrichment(pending, memory, processedAt, ports);
  }
  const replay = await replayBulkEnrichSignalRefs(pending, memory.object_id, memory.evidence_refs, ports);
  if (replay === "withheld") {
    ports.enrichPendingRepo.parkSignalRefs(pending.workspaceId, pending.memoryId);
    return "withheld";
  }
  ports.enrichPendingRepo.markProcessed(pending.workspaceId, pending.memoryId, processedAt);
  return "processed";
}

async function replayBulkEnrichSignalRefs(
  pending: BulkEnrichPendingClaim,
  memoryId: string,
  evidenceIds: readonly string[],
  ports: BulkEnrichReadyPorts
): Promise<void | "withheld"> {
  if (pending.sourceSignalId === null) return;
  if (ports.signalRefReplay === undefined || ports.signalLookup === undefined) return "withheld";
  const sourceSignal = await ports.signalLookup.getById(pending.sourceSignalId);
  if (sourceSignal === null) {
    throw new Error(
      `BULK_ENRICH signal-ref replay could not load source signal ${pending.sourceSignalId}.`
    );
  }
  if (sourceSignal.workspace_id !== pending.workspaceId) {
    throw new AlayaError("CONFLICT", "BULK_ENRICH source signal workspace does not match its obligation.");
  }
  return await ports.signalRefReplay.replaySignalRefs({
    newMemoryId: memoryId,
    memoryEvidenceIds: evidenceIds,
    signal: sourceSignal
  });
}

async function processIndependentEnrichment(
  pending: BulkEnrichPendingClaim,
  memory: BulkEnrichMemoryRecord,
  processedAt: string,
  ports: BulkEnrichReadyPorts
): Promise<void> {
  if (ports.edgeProducer !== undefined) {
    await ports.edgeProducer.produceForNewMemory({
      newMemoryId: memory.object_id,
      workspaceId: memory.workspace_id,
      runId: memory.run_id,
      sourceSignalId: pending.sourceSignalId ?? memory.object_id
    });
  }
  if (ports.conflictDetection !== undefined) {
    const scan = await ports.conflictDetection.detectAndLinkConflicts({
      newMemoryId: memory.object_id,
      newMemoryDimension: memory.dimension,
      newMemoryScopeClass: memory.scope_class,
      newMemoryContent: memory.content,
      newMemoryDomainTags: memory.domain_tags,
      workspaceId: memory.workspace_id,
      runId: memory.run_id,
      strictNoDrop: true
    });
    if (scan.availability === "unavailable") {
      throw new AlayaError("UNAVAILABLE", "conflict candidate scan unavailable");
    }
  }
  // Replay can remain withheld without repeating this completed phase on retry.
  ports.enrichPendingRepo.markIndependentProcessed(pending.workspaceId, pending.memoryId, processedAt);
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

function summarizeClaimedBatch(summary: BulkEnrichBatchSummary): readonly string[] {
  return [
    `bulk_enrich:processed_${summary.processed}`,
    `bulk_enrich:missing_${summary.missing}`,
    `bulk_enrich:failed_${summary.failed}`,
    `bulk_enrich:abandoned_${summary.abandoned}`,
    `bulk_enrich:withheld_${summary.withheld}`
  ];
}
