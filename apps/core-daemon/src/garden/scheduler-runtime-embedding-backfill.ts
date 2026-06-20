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
  try {
    const result = await resolveEmbeddingBackfillResult(input, task);
    await runEmbeddingCoherenceFollowUp(input, task, result.objectsAffected);
    await reportEmbeddingBackfillCompletion(input, task, completedAt, true, result.auditEntries, null, result.objectsAffected);
    return Object.freeze({
      success: true,
      objectsAffected: Object.freeze([...result.objectsAffected]),
      auditEntries: Object.freeze([...result.auditEntries]),
      errorMessage: null
    });
  } catch (error) {
    const failure = buildEmbeddingBackfillFailure(error);
    await reportEmbeddingBackfillCompletion(
      input,
      task,
      completedAt,
      false,
      failure.auditEntries,
      failure.errorMessage,
      failure.objectsAffected
    );
    input.warn("embedding backfill task failed; continuing Garden background pass", {
      workspace_id: task.workspace_id,
      error: failure.errorMessage
    });
    return Object.freeze(failure);
  } finally {
    pendingWorkspaces.delete(task.workspace_id);
  }
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
      error: coherenceError instanceof Error ? coherenceError.message : String(coherenceError)
    });
  }
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
