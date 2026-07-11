import { randomUUID } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { isEmbeddingBackfillPartialFailureError } from "@do-soul/alaya-core";
import type {
  CreateGardenSchedulerRuntimeSupportInput,
  EmbeddingBackfillTaskOutcome
} from "./scheduler-runtime-types.js";

const EMBEDDING_BACKFILL_DRAIN_CAP_PER_PASS = 8;
const ERROR_MESSAGE_MAX_LENGTH = 240;
const ERROR_CAUSE_MAX_DEPTH = 3;

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
  runEmbeddingBackfillPass(workspaceId: string): Promise<void>;
  runEmbeddingBackfillTask(
    task: Readonly<GardenTaskDescriptor>
  ): Promise<EmbeddingBackfillTaskOutcome>;
}> {
  const pendingEmbeddingBackfillWorkspaces = new Set<string>();
  return {
    enqueueEmbeddingBackfillForAllWorkspaces: async () =>
      await enqueueEmbeddingBackfillForAllWorkspaces(
        input,
        pendingEmbeddingBackfillWorkspaces
      ),
    runEmbeddingBackfillPass: async (workspaceId: string) =>
      await runEmbeddingBackfillPass(
        input,
        pendingEmbeddingBackfillWorkspaces,
        workspaceId
      ),
    runEmbeddingBackfillTask: async (task) =>
      await runEmbeddingBackfillTask(input, pendingEmbeddingBackfillWorkspaces, task)
  };
}

async function enqueueEmbeddingBackfillForAllWorkspaces(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>
): Promise<void> {
  const workspaces = await input.workspaceRepo.list();
  const nowIso = new Date().toISOString();
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
  pendingWorkspaces.add(workspaceId);
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
  return true;
}

async function runEmbeddingBackfillTask(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  task: Readonly<GardenTaskDescriptor>
): Promise<EmbeddingBackfillTaskOutcome> {
  const completedAt = new Date().toISOString();
  let outcome: EmbeddingBackfillTaskOutcome;
  try {
    const result = await resolveEmbeddingBackfillResult(input, task);
    await runEmbeddingCoherenceFollowUp(input, task, result.objectsAffected);
    await runEmbeddingAnswersWithFollowUp(input, task, result.objectsAffected);
    outcome = Object.freeze({
      success: true,
      objectsAffected: Object.freeze([...result.objectsAffected]),
      auditEntries: Object.freeze([...result.auditEntries]),
      errorMessage: null
    });
  } catch (error) {
    outcome = buildEmbeddingBackfillFailure(error);
    input.warn("embedding backfill task failed; continuing Garden background pass", {
      workspace_id: task.workspace_id,
      phase: "backfill",
      error: serializeCausalError(error)
    });
  }
  try {
    await persistEmbeddingBackfillCompletion(input, task, completedAt, outcome);
    return outcome;
  } finally {
    pendingWorkspaces.delete(task.workspace_id);
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
        outcome.success,
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

async function resolveEmbeddingBackfillResult(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>
): Promise<Readonly<{
  readonly objectsAffected: readonly string[];
  readonly auditEntries: readonly string[];
}>> {
  if (input.embeddingBackfillHandler === undefined) {
    return {
      objectsAffected: [],
      auditEntries: ["embedding_backfill_skipped:handler_unconfigured"]
    };
  }
  return await input.embeddingBackfillHandler.handle(task);
}

async function runEmbeddingCoherenceFollowUp(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  objectsAffected: readonly string[]
): Promise<void> {
  if (input.coherenceEdgeProducerPort === undefined || objectsAffected.length < 2) {
    return;
  }
  try {
    await input.coherenceEdgeProducerPort.crystallizeForBackfill({
      workspaceId: task.workspace_id,
      runId: null,
      objectIds: objectsAffected
    });
  } catch (coherenceError) {
    input.warn("coherence crystallization failed after embedding backfill", {
      workspace_id: task.workspace_id,
      phase: "coherence",
      error: serializeCausalError(coherenceError)
    });
  }
}

async function runEmbeddingAnswersWithFollowUp(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  objectsAffected: readonly string[]
): Promise<void> {
  if (input.answersWithEdgeProducerPort === undefined || objectsAffected.length < 2) {
    return;
  }
  try {
    await input.answersWithEdgeProducerPort.crystallizeForBackfill({
      workspaceId: task.workspace_id,
      runId: null,
      objectIds: objectsAffected
    });
  } catch (answersWithError) {
    input.warn("answers_with crystallization failed after embedding backfill", {
      workspace_id: task.workspace_id,
      phase: "answers_with",
      error: serializeCausalError(answersWithError)
    });
  }
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
  return Object.freeze({
    success: false,
    objectsAffected: Object.freeze([...objectsAffected]),
    auditEntries: Object.freeze([...auditEntries]),
    errorMessage
  });
}

async function runEmbeddingBackfillPass(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string
): Promise<void> {
  if (input.embeddingBackfillHandler === undefined) {
    return;
  }
  const firstPass = await drainEmbeddingBackfillQueue(
    input,
    pendingWorkspaces,
    workspaceId
  );
  const secondPass =
    firstPass.dispatchedCount === 0
      ? await runQueuedTargetedEmbeddingBackfill(
          input,
          pendingWorkspaces,
          workspaceId
        )
      : firstPass;
  if (secondPass.lastTargetedReason !== null) {
    throw new Error(secondPass.lastTargetedReason);
  }
}

async function runQueuedTargetedEmbeddingBackfill(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string
): Promise<Readonly<{ readonly dispatchedCount: number; readonly lastTargetedReason: string | null }>> {
  const enqueued = enqueueEmbeddingBackfillTask(
    input,
    pendingWorkspaces,
    workspaceId,
    new Date().toISOString()
  );
  if (!enqueued) {
    return { dispatchedCount: 0, lastTargetedReason: null };
  }
  input.requestBacklogTelemetryCapture(`enqueue:${GardenTaskKind.EMBEDDING_BACKFILL}`);
  return await drainEmbeddingBackfillQueue(input, pendingWorkspaces, workspaceId);
}

async function drainEmbeddingBackfillQueue(
  input: CreateGardenSchedulerRuntimeSupportInput,
  pendingWorkspaces: Set<string>,
  workspaceId: string
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
    const outcome = await runEmbeddingBackfillTask(input, pendingWorkspaces, task);
    lastTargetedReason = summarizeEmbeddingBackfillTargetedReason(outcome) ?? lastTargetedReason;
  }
  return { dispatchedCount, lastTargetedReason };
}

async function reportEmbeddingBackfillCompletion(
  input: CreateGardenSchedulerRuntimeSupportInput,
  task: Readonly<GardenTaskDescriptor>,
  completedAt: string,
  success: boolean,
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
    success,
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
