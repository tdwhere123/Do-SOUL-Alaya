import { bindEventPublisher, type RuntimeNotifier } from "@do-soul/alaya-core";
import { AlayaError, GARDEN_ROLE_TIER_MAP, GardenEventType, parseGardenEventPayload } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteGardenTaskRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createEmbeddingFollowUpEvent } from "../../garden/scheduler/embedding-backfill-checkpoint.js";

/** Called only after the runtime lease proves the previous daemon is quiescent. */
export async function recoverInterruptedEmbeddingBackfills(database: StorageDatabase,
  runtimeNotifier: RuntimeNotifier): Promise<void> {
  const publisher = bindEventPublisher({ eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier,
    purpose: "Garden embedding startup recovery" });
  const repo = new SqliteGardenTaskRepo(database.connection, publisher);
  const interrupted = database.connection.prepare(`SELECT id FROM garden_tasks WHERE kind = 'embedding_backfill'
    AND status = 'claimed' AND claimed_by = 'in-process' ORDER BY id`).all() as { id: string }[];
  for (const entry of interrupted) {
    const row = repo.findById(entry.id);
    if (row === null || row.claimed_by === null || row.claimed_at === null) {
      throw new AlayaError("CONFLICT", "Interrupted Garden task has no recoverable claim.");
    }
    const occurredAt = new Date().toISOString();
    const reclaimed = await repo.gcAbandonedClaims([{
      task_id: row.id, claimed_by: row.claimed_by, claimed_at: row.claimed_at,
      event: {
        event_type: GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
        entity_type: "garden_task", entity_id: row.id, workspace_id: row.workspace_id,
        run_id: null, caused_by: "garden-startup-recovery",
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, {
          task_id: row.id, task_kind: row.kind, role: row.role, tier: GARDEN_ROLE_TIER_MAP[row.role],
          workspace_id: row.workspace_id, run_id: null, previous_claimed_by: row.claimed_by,
          claimed_at: row.claimed_at, stale_after_ms: 0, occurred_at: occurredAt
        })
      }
    }]);
    if (reclaimed !== 1) throw new AlayaError("CONFLICT", "Interrupted Garden task changed during startup recovery.");
  }
  // Reclaim first: a crash between these operations leaves the task pending and
  // the token fenced, and the next lease holder can safely finish the release.
  const owners = database.connection.prepare(`SELECT task_id, workspace_id, owner_token, attempt_count
    FROM garden_embedding_backfill_runs WHERE owner_token IS NOT NULL ORDER BY task_id`).all() as {
      task_id: string; workspace_id: string; owner_token: string; attempt_count: number;
    }[];
  for (const owner of owners) {
    const occurredAt = new Date().toISOString();
    await publisher.appendManyWithMutation([createEmbeddingFollowUpEvent({ taskId: owner.task_id,
      workspaceId: owner.workspace_id, disposition: "recovered", attemptCount: owner.attempt_count,
      occurredAt, causedBy: "garden-startup-recovery" })], () => {
      const update = database.connection.prepare(`UPDATE garden_embedding_backfill_runs SET owner_token = NULL,
        updated_at = ? WHERE task_id = ? AND workspace_id = ? AND owner_token = ?`)
        .run(occurredAt, owner.task_id, owner.workspace_id, owner.owner_token);
      if (update.changes !== 1) throw new AlayaError("CONFLICT", "Interrupted Garden checkpoint changed during recovery.");
    });
  }
}
