import { randomUUID } from "node:crypto";
import {
  AlayaError,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { isEmbeddingBackfillPartialFailureError } from "@do-soul/alaya-core";
import type {
  CreateGardenSchedulerRuntimeSupportInput,
  EmbeddingBackfillMode,
  EmbeddingBackfillTaskOutcome
} from "./scheduler-runtime-types.js";
import { executeCheckpointedBackfill, makeOutcome } from "./embedding-backfill-execution.js";
import { runAnswersWithBackfillFollowUp } from "./embedding-backfill-follow-up.js";

const EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS = 8;
const ERROR_MESSAGE_MAX_LENGTH = 240;
const ERROR_CAUSE_MAX_DEPTH = 3;
const PATH_FOLLOW_UP_DEFERRED_AUDIT =
  "embedding_backfill_coherence_follow_up_deferred:formation_receipt_required";
const CACHE_ONLY_FOLLOW_UP_SKIPPED_AUDIT =
  "embedding_backfill_topology_follow_up_skipped:cache_only";

interface SafeCausalError {
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
  readonly cause_chain: readonly Readonly<{
    name: string;
    code: string | null;
    message: string;
  }>[];
}

export function createEmbeddingBackfillRuntimeSupport(
  input: CreateGardenSchedulerRuntimeSupportInput
): Readonly<{
  enqueueEmbeddingBackfillForAllWorkspaces(): Promise<void>;
  runEmbeddingBackfillPass(
    workspaceId: string,
    mode?: EmbeddingBackfillMode
  ): Promise<void>;
  runEmbeddingBackfillTask(
    task: Readonly<GardenTaskDescriptor>,
    mode?: EmbeddingBackfillMode
  ): Promise<EmbeddingBackfillTaskOutcome>;
  retryEmbeddingBackfillFollowUp(workspaceId?: string): Promise<Readonly<{ retried: boolean; taskId: string | null; errorMessage: string | null }>>;
}> {
  const pendingEmbeddingBackfillWorkspaces = new Set<string>();
  return {
    enqueueEmbeddingBackfillForAllWorkspaces: async () =>
      await enqueueEmbeddingBackfillForAllWorkspaces(
        input,
        pendingEmbeddingBackfillWorkspaces
      ),
    runEmbeddingBackfillPass: async (
      workspaceId: string,
      mode: EmbeddingBackfillMode = "production"
    ) =>
      await runEmbeddingBackfillPass(
        input,
        pendingEmbeddingBackfillWorkspaces,
        workspaceId,
        mode
      ),
    runEmbeddingBackfillTask: async (task, mode = "production") =>
      await runEmbeddingBackfillTask(input, pendingEmbeddingBackfillWorkspaces, task, mode),
    retryEmbeddingBackfillFollowUp: async workspaceId => await retryEmbeddingBackfillFollowUp(input, workspaceId)
  };
}

async function enqueueEmbeddingBackfillForAllWorkspaces(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>
): Promise<void> {
  const workspaces = await input.workspaceRepo.list();
  const nowIso = input.now();
  let enqueuedCount = 0;

  for (const workspace of workspaces) {
    const enqueued = enqueueEmbeddingBackfillTask(
      input,
      pendingWorkspaces,
      workspace.workspace_id,
      nowIso
    );
    enqueuedCount += enqueued ? 1 : 0;
  }

  if (enqueuedCount > 0) {
    input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);
  }
}

function enqueueEmbeddingBackfillTask(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string,
  createdAt: string
): boolean {
  if (pendingWorkspaces.has(workspaceId)) {
    return false;
  }
  input.gardenScheduler.enqueue({
    task_id: randomUUID(),
    task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
    required_tier: GardenTier.TIER_2,
    workspace_id: workspaceId,
    run_id: null,
    target_object_refs: [workspaceId],
    priority: 10,
    created_at: createdAt
  });
  pendingWorkspaces.add(workspaceId);
  return true;
}

async function runEmbeddingBackfillTask(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  task: Readonly<GardenTaskDescriptor>,
  mode: EmbeddingBackfillMode = "production"
): Promise<EmbeddingBackfillTaskOutcome> {
  const completedAt = input.now();
  const checkpoint = input.embeddingBackfillCheckpoint;
  try {
    if (checkpoint === undefined) {
      const outcome = await executeWithoutCheckpoint(input, task, mode);
      await persistEmbeddingBackfillCompletion(input, task, completedAt, outcome);
      return outcome;
    }
    const checkpointMode = mode === "cache_only" ? "cache_only"
      : input.answersWithEdgeProducerPort === undefined ? "unwired" : "production";
    const claim = checkpoint.claimTask(task, checkpointMode);
    if (claim === null) {
      if (checkpoint.isOwnedByAnotherTask(task.task_id, task.workspace_id)) {
        await input.gardenScheduler.releaseInProcessClaim?.(task.task_id);
      }
      throw new AlayaError("CONFLICT", "Garden embedding backfill is already owned.");
    }
    if (mode === "cache_only" && checkpoint.read(claim).mode !== "cache_only") {
      checkpoint.release(claim);
      await input.gardenScheduler.releaseInProcessClaim?.(task.task_id);
      throw new AlayaError("CONFLICT", "Garden backfill mode is pinned to a production follow-up.");
    }
    let outcome: EmbeddingBackfillTaskOutcome;
    try {
      outcome = await executeCheckpointedBackfill(input, task, checkpoint, claim,
        buildEmbeddingBackfillFailure, sanitizeDurableErrorMessage);
    } catch (error) {
      const row = checkpoint.read(claim);
      if (row.state === "backfilling") throw error;
      input.warn("embedding follow-up checkpoint settlement failed", {
        workspace_id: task.workspace_id, phase: "follow_up_completion", error: serializeCausalError(error)
      });
      outcome = makeOutcome("failed", checkpoint.objectIds(claim),
        ["embedding_backfill_follow_up_completion_unavailable"], "embedding_backfill_follow_up_completion_unavailable");
    }
    await persistEmbeddingBackfillCompletion(input, task, completedAt, outcome);
    checkpoint.release(claim);
    return outcome;
  } finally {
    pendingWorkspaces.delete(task.workspace_id);
  }
}

async function executeWithoutCheckpoint(input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>, mode: EmbeddingBackfillMode): Promise<EmbeddingBackfillTaskOutcome> {
  try {
    if (mode !== "cache_only" && input.answersWithEdgeProducerPort !== undefined) {
      throw new AlayaError("UNAVAILABLE", "Garden embedding follow-up checkpoint is not configured.");
    }
    if (input.embeddingBackfillHandler === undefined) {
      throw new AlayaError("UNAVAILABLE", "embedding backfill handler is not configured");
    }
    const result = await input.embeddingBackfillHandler.handle(task);
    const unwired = mode !== "cache_only" && result.objectsAffected.length >= 2;
    const outcome = unwired ? "failed" : result.outcome;
    const entries = [...result.auditEntries];
    if (mode === "cache_only") entries.push(CACHE_ONLY_FOLLOW_UP_SKIPPED_AUDIT);
    else if (unwired) entries.push("embedding_backfill_answers_with_follow_up_blocked:unwired", PATH_FOLLOW_UP_DEFERRED_AUDIT);
    return makeOutcome(outcome, result.objectsAffected, entries,
      unwired ? "embedding_backfill_answers_with_follow_up_blocked:unwired" : result.errorMessage ?? null);
  } catch (error) {
    input.warn("embedding backfill task failed; continuing Garden background pass", {
      workspace_id: task.workspace_id, phase: "backfill", error: serializeCausalError(error)
    });
    return buildEmbeddingBackfillFailure(error);
  }
}

async function retryEmbeddingBackfillFollowUp(input: CreateGardenSchedulerRuntimeSupportInput,
  workspaceId?: string, excludedTaskIds: readonly string[] = []): Promise<Readonly<{
    retried: boolean; taskId: string | null; errorMessage: string | null;
  }>> {
  const checkpoint = input.embeddingBackfillCheckpoint;
  const claim = checkpoint === undefined ? null : await checkpoint.claimPending(workspaceId, excludedTaskIds);
  if (checkpoint === undefined || claim === null) return { retried: false, taskId: null, errorMessage: null };
  try {
    const result = await runAnswersWithBackfillFollowUp(input, checkpoint, claim);
    return { retried: true, taskId: claim.taskId, errorMessage: result.errorMessage };
  } catch (error) {
    input.warn("embedding follow-up retry could not settle", {
      workspace_id: claim.workspaceId, phase: "follow_up_completion", error: serializeCausalError(error)
    });
    return { retried: true, taskId: claim.taskId, errorMessage: "embedding_backfill_follow_up_completion_unavailable" };
  } finally {
    checkpoint.release(claim);
  }
}

async function persistEmbeddingBackfillCompletion(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  completedAt: string,
  outcome: EmbeddingBackfillTaskOutcome
): Promise<void> {
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await reportEmbeddingBackfillCompletion(
        input,
        task,
        completedAt,
        outcome,
        outcome.auditEntries,
        sanitizeDurableErrorMessage(outcome.errorMessage),
        outcome.objectsAffected
      );
      if (failures.length > 0) {
        input.warn("embedding backfill completion retry succeeded", {
          workspace_id: task.workspace_id,
          phase: "completion",
          attempt,
          error: serializeCausalError(failures[0])
        });
      }
      return;
    } catch (error) {
      failures.push(error);
    }
  }
  input.warn("embedding backfill completion persistence failed", {
    workspace_id: task.workspace_id,
    phase: "completion",
    attempts: failures.length,
    error: serializeCausalError(failures.at(-1))
  });
  throw new AggregateError(
    failures,
    "embedding backfill completion persistence failed"
  );
}

function sanitizeDurableErrorMessage(message: string | null): string | null {
  return message === null ? null : sanitizeErrorText(message);
}

function serializeCausalError(error: unknown): SafeCausalError {
  const seen = new Set<unknown>();
  const root = readSafeError(error);
  const causeChain: Array<Omit<SafeCausalError, "cause_chain">> = [];
  let cause = readCause(error);
  while (
    cause !== undefined &&
    causeChain.length < ERROR_CAUSE_MAX_DEPTH &&
    !seen.has(cause)
  ) {
    seen.add(cause);
    causeChain.push(readSafeError(cause));
    cause = readCause(cause);
  }
  return Object.freeze({ ...root, cause_chain: Object.freeze(causeChain) });
}

function readSafeError(error: unknown): Omit<SafeCausalError, "cause_chain"> {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", code: null, message: sanitizeErrorText(String(error)) };
  }
  return {
    name: sanitizeErrorName(error.name),
    code: readSafeErrorCode(error),
    message: sanitizeErrorText(error.message)
  };
}

function readCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return (error as { readonly cause?: unknown }).cause;
}

function readSafeErrorCode(error: Error): string | null {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,64}$/u.test(code)
    ? code
    : null;
}

function sanitizeErrorName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : "Error";
}

function sanitizeErrorText(message: string): string {
  const redacted = message
    .replace(/\b(?:authorization|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "credential=[redacted]")
    .replace(/https?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/gu, "[redacted-path]")
    .replace(/(?:\/[A-Za-z0-9._~+-]+){2,}/gu, "[redacted-path]");
  return redacted.slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

function buildEmbeddingBackfillFailure(error: unknown): EmbeddingBackfillTaskOutcome {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const objectsAffected = isEmbeddingBackfillPartialFailureError(error) ? error.objectsAffected : [];
  const auditEntries = isEmbeddingBackfillPartialFailureError(error) ? error.auditEntries : [];
  return makeOutcome("failed", objectsAffected, auditEntries, errorMessage);
}

async function runEmbeddingBackfillPass(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string,
  mode: EmbeddingBackfillMode
): Promise<void> {
  if (input.embeddingBackfillCheckpoint?.hasActiveWorkspace(workspaceId) === true) {
    throw new AlayaError("CONFLICT", "Garden embedding backfill is already owned.");
  }
  if (mode === "production" && await retryTargetedFollowUps(input, workspaceId)) return;
  if (input.embeddingBackfillHandler === undefined) {
    throw new AlayaError("UNAVAILABLE", "embedding backfill handler is not configured");
  }
  const firstPass = await drainEmbeddingBackfillQueue(
    input,
    pendingWorkspaces,
    workspaceId,
    mode
  );
  const secondPass =
    firstPass.dispatchedCount === 0
      ? await runQueuedTargetedEmbeddingBackfill(
          input,
          pendingWorkspaces,
          workspaceId,
          mode
        )
      : firstPass;
  if (secondPass.lastTargetedReason !== null) {
    throw new AlayaError("UNAVAILABLE", secondPass.lastTargetedReason);
  }
}

async function retryTargetedFollowUps(input: CreateGardenSchedulerRuntimeSupportInput,
  workspaceId: string): Promise<boolean> {
  const attempted: string[] = [];
  let failure: string | null = null;
  for (let index = 0; index < EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS; index += 1) {
    const result = await retryEmbeddingBackfillFollowUp(input, workspaceId, attempted);
    if (!result.retried || result.taskId === null) break;
    attempted.push(result.taskId);
    failure ??= result.errorMessage;
  }
  if (failure !== null) throw new AlayaError("UNAVAILABLE", failure);
  if (input.embeddingBackfillCheckpoint?.hasBlockedWorkspace(workspaceId) === true) {
    throw new AlayaError("CONFLICT", "Garden embedding follow-up is blocked; inspection is required.");
  }
  if (input.embeddingBackfillCheckpoint?.hasPendingRetryWorkspace(workspaceId) === true) {
    throw new AlayaError("UNAVAILABLE", "Garden embedding follow-up remains pending.");
  }
  return attempted.length > 0;
}

async function runQueuedTargetedEmbeddingBackfill(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string,
  mode: EmbeddingBackfillMode
): Promise<Readonly<{ readonly dispatchedCount: number; readonly lastTargetedReason: string | null }>> {
  const enqueued = enqueueEmbeddingBackfillTask(
    input,
    pendingWorkspaces,
    workspaceId,
    input.now()
  );
  if (!enqueued) {
    return { dispatchedCount: 0, lastTargetedReason: null };
  }
  input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);
  return await drainEmbeddingBackfillQueue(input, pendingWorkspaces, workspaceId, mode);
}

async function drainEmbeddingBackfillQueue(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string,
  mode: EmbeddingBackfillMode
): Promise<Readonly<{ readonly dispatchedCount: number; readonly lastTargetedReason: string | null }>> {
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
    const outcome = await runEmbeddingBackfillTask(input, pendingWorkspaces, task, mode);
    lastTargetedReason = summarizeEmbeddingBackfillTargetedReason(outcome) ?? lastTargetedReason;
  }
  return { dispatchedCount, lastTargetedReason };
}

async function reportEmbeddingBackfillCompletion(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  completedAt: string,
  outcome: EmbeddingBackfillTaskOutcome,
  auditEntries: readonly string[],
  errorMessage: string | null,
  objectsAffected: readonly string[]
): Promise<void> {
  await input.gardenScheduler.reportCompletion({
    task_id: task.task_id,
    task_kind: task.task_kind,
    role: GardenRole.LIBRARIAN,
    tier: GardenTier.TIER_2,
    workspace_id: task.workspace_id,
    success: outcome.success,
    outcome: outcome.outcome,
    objects_affected: [...objectsAffected],
    audit_entries: [...auditEntries],
    error_message: errorMessage,
    completed_at: completedAt
  });
}

function summarizeEmbeddingBackfillTargetedReason(
  outcome: EmbeddingBackfillTaskOutcome
): string | null {
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
}
