import { GardenTaskOutcomeSchema } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseRows, readNonEmptyStringField, readNonNegativeIntField, readNullableStringField,
  readRecord, readSqliteBooleanIntField } from "../shared/parse-row.js";
import { parseNonEmptyString } from "../shared/validators.js";
import { parseLimit } from "./mappers/garden-task-rows.js";

/** Reference-only operator projection; these obligations are not MCP-claimable tasks. */
export function listEmbeddingFollowUps(connection: SqliteConnection, workspaceId: string, limit: number) {
  const rows = connection.prepare(`SELECT r.task_id, r.state, r.owner_token IS NOT NULL AS in_flight,
      r.attempt_count, r.last_error AS reason, t.outcome AS parent_outcome
    FROM garden_embedding_backfill_runs r JOIN garden_tasks t
      ON t.id = r.task_id AND t.workspace_id = r.workspace_id
    WHERE r.workspace_id = ? AND r.state IN ('pending', 'blocked')
    ORDER BY r.updated_at, r.task_id LIMIT ?`).all(parseNonEmptyString(workspaceId, "garden_task.workspace_id"), parseLimit(limit));
  return parseRows(rows, { parse(value: unknown) {
    const record = readRecord(value, "garden embedding follow-up row");
    const state = readNonEmptyStringField(record, "state");
    if (state !== "pending" && state !== "blocked") throw new StorageError("VALIDATION_FAILED", "Invalid Garden follow-up state.");
    return Object.freeze({
      task_id: readNonEmptyStringField(record, "task_id"), state,
      in_flight: readSqliteBooleanIntField(record, "in_flight") === 1,
      attempt_count: readNonNegativeIntField(record, "attempt_count"),
      reason: readNullableStringField(record, "reason"),
      parent_outcome: GardenTaskOutcomeSchema.nullable().parse(readNullableStringField(record, "parent_outcome"))
    });
  } }, "garden embedding follow-up");
}
