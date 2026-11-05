import type { EventPublisher } from "@do-soul/alaya-core";
import {
  AlayaError,
  gardenTaskOutcomeSuccess,
  GardenEventType,
  GardenRole,
  GardenTier,
  parseGardenEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { GardenTaskRow, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import type { SignalOutcomeCounts } from "../post-turn-extract/signal-receiver.js";

export const IN_PROCESS_CLAIMANT = "in-process";

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
  outcome: Readonly<{ status: "completed" } | { status: "failed"; error: unknown }> & Readonly<{
    emittedSignalIds?: readonly string[];
    signalCounts?: SignalOutcomeCounts;
  }>,
  gardenTaskRepo: SqliteGardenTaskRepo,
  now: () => string
): Promise<void> {
  const completedAt = now();
  const objectsAffected = outcome.emittedSignalIds ?? [];
  await gardenTaskRepo.completeWithEvents(
    row.id,
    outcome.status === "completed"
      ? { status: "completed", outcome: outcome.status, completed_at: completedAt }
      : { status: "failed", outcome: outcome.status, completed_at: completedAt,
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
          success: gardenTaskOutcomeSuccess(outcome.status),
          outcome: outcome.status,
          objects_affected: [...objectsAffected],
          candidate_signals_count: objectsAffected.length,
          ...(outcome.signalCounts ?? {}),
          workspace_id: row.workspace_id,
          occurred_at: completedAt
        })
      }
    ],
    IN_PROCESS_CLAIMANT,
    row.workspace_id
  );
}
