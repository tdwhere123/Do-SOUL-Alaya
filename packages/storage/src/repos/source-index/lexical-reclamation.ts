import { BoundedIdSchema, SourceIndexOperationError, type SourceIndexBudget,
  type SourceIndexLexicalReclamationResult } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { readIntegerField, readRecord, readStringField } from "../shared/parse-row.js";
import { dropLexicalDomain } from "./lexical-domain.js";
import { assertIndexBudget, assertIndexPageLimit } from "./native-source.js";

/** A page is one IMMEDIATE transaction. Remaining rows are the durable cursor; a failed page
 * rolls back, and a lost reply can safely retry. Active domains are excluded inside that same CAS.
 * Other connections' pinned SQLite snapshots retain the old schema/rows through WAL MVCC: physical
 * page reuse/checkpoint cannot pass them. No process-local registry can replace that protection.
 * The transaction-free requirement prevents mutating a caller's own frozen reader. */
export function reclaimLexicalPage(database: StorageDatabase, workspaceId: string, limit: number,
  budget: SourceIndexBudget): SourceIndexLexicalReclamationResult {
  BoundedIdSchema.parse(workspaceId); assertIndexPageLimit(limit); assertIndexBudget(budget);
  const resources = { work: 0, native_bytes: 0 };
  const result = { projections: 0, targets: 0, generations: 0, resources, complete: false };
  database.reopenIfClosed();
  if (database.connection.inTransaction) throw new StorageError("CONFLICT", "lexical reclamation requires a transaction-free caller");
  // One digest read, two bounded row-id probes, and a possible domain drop. Native bytes are
  // returned metadata only; SQLite-internal FTS deletion, writes and physical disk work are unknown.
  if (budget.work < 4 || budget.native_bytes < 71) return result;
  try { return database.connection.transaction(() => {
    const raw = database.connection.prepare(`SELECT g.generation_id FROM source_index_lexical_generations g
      WHERE g.workspace_id=? AND g.status='retired' AND NOT EXISTS (
        SELECT 1 FROM source_index_lexical_selections s WHERE s.workspace_id=g.workspace_id
          AND s.active_generation_id=g.generation_id) ORDER BY g.generation_id LIMIT 1`).get(workspaceId);
    resources.work++;
    if (raw === undefined) return { ...result, complete: true };
    const generation = readStringField(readRecord(raw, "retired lexical generation"), "generation_id");
    resources.native_bytes += Buffer.byteLength(generation);
    for (const [table, count] of [["source_index_lexical_projections", "projections"],
      ["source_index_lexical_targets", "targets"]] as const) {
      const remainingRows = limit - result.projections - result.targets;
      const size = Math.min(remainingRows, Math.floor((budget.work - resources.work - 2) / 2),
        Math.floor((budget.native_bytes - resources.native_bytes) / 8));
      if (size < 1) return result;
      const rows = database.connection.prepare(`SELECT rowid AS id FROM ${table}
        WHERE workspace_id=? AND generation_id=? ORDER BY rowid LIMIT ?`).all(workspaceId, generation, size);
      resources.work++; resources.native_bytes += 8 * rows.length;
      const remove = database.connection.prepare(`DELETE FROM ${table} WHERE rowid=? AND workspace_id=? AND generation_id=?`);
      for (const row of rows) {
        resources.work++;
        remove.run(readIntegerField(readRecord(row, "retired lexical row"), "id"), workspaceId, generation);
        result[count]++;
      }
      if (rows.length === size) return result;
    }
    resources.work++;
    dropLexicalDomain(database.connection, generation);
    database.connection.prepare("DELETE FROM source_index_lexical_generations WHERE workspace_id=? AND generation_id=?")
      .run(workspaceId, generation);
    result.generations++;
    return result;
  }).immediate(); } catch (error) { throw new SourceIndexOperationError(error, resources); }
}
