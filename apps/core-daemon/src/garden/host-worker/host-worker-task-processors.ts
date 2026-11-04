import type { EventPublisher } from "@do-soul/alaya-core";
import {
  AlayaError,
  GardenEventType,
  GardenRole,
  GardenTier,
  parseGardenEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { GardenTaskRow, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";

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
  outcome: Readonly<{ success: true } | { success: false; error: unknown }> & Readonly<{
    emittedSignalIds?: readonly string[];
    failedSignalCount?: number;
    unknownSignalCount?: number;
  }>,
  gardenTaskRepo: SqliteGardenTaskRepo,
  now: () => string
): Promise<void> {
  const completedAt = now();
  const objectsAffected = outcome.emittedSignalIds ?? [];
  const failedSignalCount = outcome.failedSignalCount ?? 0;
  const unknownSignalCount = outcome.unknownSignalCount ?? 0;
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
          ...(unknownSignalCount === 0 ? {} : { unknown_candidate_signals_count: unknownSignalCount }),
          workspace_id: row.workspace_id,
          occurred_at: completedAt
        })
      }
    ],
    IN_PROCESS_CLAIMANT,
    row.workspace_id
  );
}
