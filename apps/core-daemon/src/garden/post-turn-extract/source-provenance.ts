import { GardenEventType, GardenRole, GardenTaskKind, GardenTier, parseGardenEventPayload } from "@do-soul/alaya-protocol";
import type { GardenTaskRow, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";

export type GardenTaskSourceGuardPort = Partial<Pick<SqliteGardenTaskRepo,
  "hasAvailableSource" | "quarantineUnavailablePostTurnTasks">>;

export function gardenTaskSourceAvailable(repo: GardenTaskSourceGuardPort, row: GardenTaskRow): boolean {
  return row.kind !== GardenTaskKind.POST_TURN_EXTRACT || repo.hasAvailableSource?.(row.id, row.workspace_id) === true;
}

/** Source availability is rechecked by SQLite in the audit transaction. Historical payloads stay private. */
export async function quarantineUnavailablePostTurnTasks(
  repo: GardenTaskSourceGuardPort,
  now: () => string,
  workspaceId?: string,
  taskId?: string
): Promise<void> {
  const completedAt = now();
  await repo.quarantineUnavailablePostTurnTasks?.(completedAt, row => ({
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: row.id,
    workspace_id: row.workspace_id,
    run_id: null,
    caused_by: "garden-source-provenance",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: row.id,
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: row.workspace_id,
      success: false,
      objects_affected: [],
      candidate_signals_count: 0,
      occurred_at: completedAt
    })
  }), workspaceId, taskId);
}
