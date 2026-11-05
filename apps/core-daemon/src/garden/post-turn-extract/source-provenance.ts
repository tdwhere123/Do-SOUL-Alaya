import { gardenTaskOutcomeSuccess, GardenEventType, GardenRole, GardenTaskKind, GardenTier, parseGardenEventPayload } from "@do-soul/alaya-protocol";
import type { GardenTaskRow, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";

export type GardenTaskSourceGuardPort = Partial<Pick<SqliteGardenTaskRepo,
  "hasAvailableSource" | "quarantineUnavailableSourceTasks">>;

const SOURCE_BOUND_TASK_KINDS: ReadonlySet<string> = new Set([GardenTaskKind.POST_TURN_EXTRACT, GardenTaskKind.SOURCE_STATEMENT_SESSION]);

export function gardenTaskSourceAvailable(repo: GardenTaskSourceGuardPort, row: GardenTaskRow): boolean {
  return !SOURCE_BOUND_TASK_KINDS.has(row.kind) || repo.hasAvailableSource?.(row.id, row.workspace_id) === true;
}

/** Source availability is rechecked by SQLite in the audit transaction. Historical payloads stay private. */
export async function quarantineUnavailableSourceTasks(
  repo: GardenTaskSourceGuardPort,
  now: () => string,
  workspaceId?: string,
  taskId?: string
): Promise<void> {
  const completedAt = now();
  await repo.quarantineUnavailableSourceTasks?.(completedAt, row => ({
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: row.id,
    workspace_id: row.workspace_id,
    run_id: null,
    caused_by: "garden-source-provenance",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: row.id,
      task_kind: row.kind,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: row.workspace_id,
      success: gardenTaskOutcomeSuccess("failed"),
      outcome: "failed",
      objects_affected: [],
      candidate_signals_count: 0,
      occurred_at: completedAt
    })
  }), workspaceId, taskId);
}
