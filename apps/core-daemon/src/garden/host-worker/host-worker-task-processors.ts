import type { EventPublisher } from "@do-soul/alaya-core";
import {
  AlayaError,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";
import type { PostTurnSignalReceiver } from "../post-turn-extract/signal-receiver.js";
import { finalizePostTurnEvidence } from "../post-turn-extract/evidence-finalizer.js";
import {
  buildPostTurnContent,
  buildPostTurnConversationMessages,
  parsePostTurnExtractTaskPayload,
  type PostTurnExtractTaskPayload
} from "../post-turn-extract/task-payload.js";
import { quarantineUnavailableSourceTasks } from "../post-turn-extract/source-provenance.js";

export const IN_PROCESS_CLAIMANT = "in-process";
type PostTurnExtractTaskRow = Readonly<{
  readonly row: GardenTaskRow;
  readonly claimedAt: string;
}>;

type PostTurnExtractRuntimeInput = Readonly<{
  readonly now: () => string;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly eventPublisher: EventPublisher;
  readonly signalReceiver?: PostTurnSignalReceiver;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>;
type PostTurnExtractRuntime = PostTurnExtractRuntimeInput & {
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalReceiver: PostTurnSignalReceiver;
};

/** Post-turn work has no model step: it retains the admitted turn as evidence in every compute mode. */
export function createPostTurnExtractTaskProcessor(
  input: PostTurnExtractRuntimeInput
): () => Promise<void> {
  return async (): Promise<void> => {
    if (input.gardenTaskRepo === undefined || input.signalReceiver === undefined) {
      return;
    }
    const runtime = { ...input, gardenTaskRepo: input.gardenTaskRepo, signalReceiver: input.signalReceiver };
    const task = await claimPostTurnExtractTask(runtime);
    if (task === null) {
      return;
    }
    await processClaimedPostTurnExtractTask(task, runtime);
  };
}

async function claimPostTurnExtractTask(input: PostTurnExtractRuntime): Promise<PostTurnExtractTaskRow | null> {
  await quarantineUnavailableSourceTasks(input.gardenTaskRepo, input.now);
  const row = input.gardenTaskRepo
    .peekPending(GardenRole.LIBRARIAN, undefined, 1, GardenTaskKind.POST_TURN_EXTRACT)[0];
  if (row === undefined) {
    return null;
  }
  const claimedAt = input.now();
  const claimResult = await input.gardenTaskRepo.claimAtomic(
    row.id,
    IN_PROCESS_CLAIMANT,
    claimedAt,
    row.workspace_id
  );
  return claimResult === "claimed" ? { row, claimedAt } : null;
}

async function processClaimedPostTurnExtractTask(
  task: PostTurnExtractTaskRow,
  input: PostTurnExtractRuntime
): Promise<void> {
  let payload: PostTurnExtractTaskPayload;
  try {
    payload = parsePostTurnExtractTaskPayload(task.row.payload);
  } catch (error) {
    await input.gardenTaskRepo.releaseClaim(task.row.id, IN_PROCESS_CLAIMANT);
    throw error;
  }
  try {
    await publishInProcessTaskDispatch(task.row, payload.run_id, task.claimedAt, input.eventPublisher);
    await quarantineUnavailableSourceTasks(input.gardenTaskRepo, input.now, task.row.workspace_id, task.row.id);
    const failedSignalIds = new Set<string>();
    const retainedIds = await finalizePostTurnEvidence({
      taskId: task.row.id,
      workspaceId: payload.workspace_id,
      runId: payload.run_id,
      createdAt: payload.created_at ?? task.row.created_at,
      turnContent: buildPostTurnContent(payload),
      turnMessages: buildPostTurnConversationMessages(payload, task.row.id),
      sourceObservation: null,
      candidates: [],
      signalReceiver: input.signalReceiver,
      failedSignalIds,
      ...(payload.admitted_source_root_id === undefined
        ? {}
        : { admittedSourceRootId: payload.admitted_source_root_id }),
      beforeReceive: async () => await refreshInProcessClaim(input.gardenTaskRepo, task.row.id, input.now)
    });
    await settleInProcessTask(task.row, payload.run_id,
      { success: true, emittedSignalIds: retainedIds, failedSignalCount: failedSignalIds.size }, input.gardenTaskRepo, input.now);
  } catch (error) {
    await quarantineUnavailableSourceTasks(input.gardenTaskRepo, input.now, task.row.workspace_id, task.row.id);
    if (input.gardenTaskRepo.findByIdInWorkspace(task.row.id, task.row.workspace_id)?.status !== "claimed") {
      return;
    }
    await settleInProcessTask(task.row, payload.run_id, { success: false, error }, input.gardenTaskRepo, input.now);
  }
}

/** Audit-first dispatch of an in-process claimed garden task. */
export async function publishInProcessTaskDispatch(
  row: GardenTaskRow,
  runId: string,
  claimedAt: string,
  eventPublisher: EventPublisher
): Promise<EventLogEntry> {
  return await eventPublisher.publish({
    event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
    entity_type: "garden_task",
    entity_id: row.id,
    workspace_id: row.workspace_id,
    run_id: runId,
    caused_by: "garden-runtime",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, {
      task_id: row.id,
      task_kind: row.kind,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: row.workspace_id,
      run_id: runId,
      occurred_at: claimedAt
    })
  });
}

export async function refreshInProcessClaim(
  gardenTaskRepo: SqliteGardenTaskRepo,
  taskId: string,
  now: () => string
): Promise<void> {
  if (gardenTaskRepo.refreshClaim(taskId, IN_PROCESS_CLAIMANT, now())) {
    return;
  }
  throw new AlayaError("CONFLICT", `Garden task ${taskId} claim changed before candidate signal emission.`);
}

/** Completes or fails an in-process claim together with its completion audit. */
export async function settleInProcessTask(
  row: GardenTaskRow,
  runId: string,
  outcome: Readonly<{ success: true } | { success: false; error: unknown }> & Readonly<{
    emittedSignalIds?: readonly string[];
    failedSignalCount?: number;
  }>,
  gardenTaskRepo: SqliteGardenTaskRepo,
  now: () => string
): Promise<void> {
  const completedAt = now();
  const objectsAffected = outcome.emittedSignalIds ?? [];
  const failedSignalCount = outcome.failedSignalCount ?? 0;
  await gardenTaskRepo.completeWithEvents(
    row.id,
    outcome.success
      ? { status: "completed", completed_at: completedAt }
      : { status: "failed", completed_at: completedAt,
        last_error_text: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) },
    [
      {
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_type: "garden_task",
        entity_id: row.id,
        workspace_id: row.workspace_id,
        run_id: runId,
        caused_by: "garden-runtime",
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
          task_id: row.id,
          task_kind: row.kind,
          role: GardenRole.LIBRARIAN,
          tier: GardenTier.TIER_2,
          success: outcome.success,
          objects_affected: [...objectsAffected],
          candidate_signals_count: objectsAffected.length,
          ...(failedSignalCount === 0 ? {} : { failed_candidate_signals_count: failedSignalCount }),
          workspace_id: row.workspace_id,
          occurred_at: completedAt
        })
      }
    ],
    IN_PROCESS_CLAIMANT,
    row.workspace_id
  );
}
