import { BoundedIdSchema, SourceIndexOperationError, type SourceIndexBudget,
  type SourceIndexVectorReclamationResult } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { readIntegerField, readRecord, readStringField } from "../shared/parse-row.js";
import { assertIndexBudget, assertIndexPageLimit } from "./native-source.js";

/** Retired-only maintenance; each page owns an IMMEDIATE transaction and remaining rows are its cursor.
 * Other connections' pinned WAL snapshots retain old rows until release. The shared root/dependency
 * index and erase barriers are not generation payload and remain available to the erasure owner. */
export function reclaimVectorPage(database: StorageDatabase, workspaceId: string, limit: number,
  budget: SourceIndexBudget): SourceIndexVectorReclamationResult {
  BoundedIdSchema.parse(workspaceId); assertIndexPageLimit(limit); assertIndexBudget(budget);
  const resources = { work: 0, native_bytes: 0 };
  const result = { vectors: 0, windows: 0, targets: 0, generations: 0, resources, complete: false };
  database.reopenIfClosed();
  if (database.connection.inTransaction) throw new StorageError("CONFLICT", "vector reclamation requires a transaction-free caller");
  if (budget.work < 6 || budget.native_bytes < 79) return result;
  try { return database.connection.transaction(() => {
    const raw = database.connection.prepare(`SELECT g.generation_id,g.status FROM source_index_generations g
      LEFT JOIN source_index_epochs e ON e.workspace_id=g.workspace_id
      WHERE g.workspace_id=? AND (g.status='retired' OR
        (g.status IN ('building','partial','failed') AND g.source_epoch<COALESCE(e.epoch,0))) AND NOT EXISTS (
        SELECT 1 FROM source_index_selections s WHERE s.workspace_id=g.workspace_id
          AND s.active_generation_id=g.generation_id) ORDER BY g.generation_id LIMIT 1`).get(workspaceId);
    resources.work++;
    if (raw === undefined) return { ...result, complete: true };
    const row = readRecord(raw, "retired vector generation");
    const generation = readStringField(row, "generation_id"), status = readStringField(row, "status");
    resources.native_bytes += Buffer.byteLength(generation) + Buffer.byteLength(status);
    if (status !== "retired") {
      // Epoch guards already reject this unpointed build; retire it before any payload is deleted.
      database.connection.prepare("UPDATE source_index_generations SET status='retired',reason='source_epoch_superseded' WHERE workspace_id=? AND generation_id=?")
        .run(workspaceId, generation);
      resources.work++;
    }
    const tables = [["source_index_vectors", "window_id", "vectors"], ["source_index_windows", "window_id", "windows"],
      ["source_index_targets", "root_key", "targets"]] as const;
    for (const [index, [table, key, count]] of tables.entries()) {
      const remainingRows = limit - result.vectors - result.windows - result.targets;
      // Reserve the current/later probes and the final metadata deletion.
      const remainingPhases = 4 - index;
      const size = Math.min(remainingRows, budget.work - resources.work - remainingPhases,
        Math.floor((budget.native_bytes - resources.native_bytes) / 8));
      if (size < 1) return result;
      const rows = database.connection.prepare(`SELECT rowid AS id FROM ${table}
        WHERE workspace_id=? AND generation_id=? ORDER BY ${key} LIMIT ?`).all(workspaceId, generation, size);
      resources.work++; resources.native_bytes += 8 * rows.length;
      const remove = database.connection.prepare(`DELETE FROM ${table} WHERE rowid=? AND workspace_id=? AND generation_id=?`);
      for (const row of rows) {
        resources.work++;
        remove.run(readIntegerField(readRecord(row, "retired vector row"), "id"), workspaceId, generation);
        result[count]++;
      }
      if (rows.length === size) return result;
    }
    resources.work++;
    database.connection.prepare("DELETE FROM source_index_generations WHERE workspace_id=? AND generation_id=? AND status='retired'")
      .run(workspaceId, generation);
    result.generations++;
    return result;
  }).immediate(); } catch (error) { throw new SourceIndexOperationError(error, resources); }
}
