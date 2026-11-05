import type { StorageDatabase } from "../../../../sqlite/db.js";
import type { FieldEraseBarrierRow } from "../../ports.js";
import { fieldEraseBarrierParser } from "../../mappers/mappers.js";
import { parseRows } from "../../../shared/parse-row.js";
import { StorageError } from "../../../../shared/errors.js";

/** Bump when closure discovery or scrubbing gains a new historical obligation. */
const CLOSURE_RULE_VERSION = 1;
const BARRIERS_PER_BATCH = 32;

/** One SQLite writer transaction owns the scrub and its checkpoint. Readers are not opened by startup
 * until all batches finish. A failed batch rolls back its cursor and suppression flag together.
 */
export function repairSourceClosureBatch(database: StorageDatabase,
  apply: (row: FieldEraseBarrierRow) => unknown): boolean {
  const connection = database.connection;
  return connection.transaction(() => {
    if (connection.prepare("SELECT 1 FROM source_erase_closure_progress WHERE rule_version > ? LIMIT 1")
      .get(CLOSURE_RULE_VERSION) !== undefined) throw new StorageError("CONFLICT", "source erase closure rules are newer than this runtime");
    const select = (where: string, order: string, args: readonly number[]) => connection.prepare(`
      SELECT b.receipt_identity AS identity, b.barrier_id, b.workspace_id, b.generation_id,
        b.subject_kind, b.subject_id, b.erased_at FROM source_erase_closure_progress p
      JOIN projection_erase_barriers b ON b.workspace_id = p.workspace_id AND b.barrier_id = p.barrier_id
      WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...args, BARRIERS_PER_BATCH);
    const outdated = select("p.rule_version < ?", "p.rule_version, p.workspace_id, p.barrier_id", [CLOSURE_RULE_VERSION]);
    const rows = parseRows(outdated.length > 0 ? outdated : select("p.dirty = 1", "p.workspace_id, p.barrier_id", []),
      fieldEraseBarrierParser, "existing source erase barrier");
    if (rows.length === 0) return false;
    // Other writers cannot observe this flag: it is cleared before the same writer transaction commits.
    connection.prepare("UPDATE source_erase_repair_control SET repairing = 1 WHERE singleton = 1").run();
    const complete = connection.prepare(`UPDATE source_erase_closure_progress
      SET rule_version = ?, checked_revision = data_revision, dirty = 0 WHERE workspace_id = ? AND barrier_id = ?`);
    for (const row of rows) {
      apply(row);
      complete.run(CLOSURE_RULE_VERSION, row.workspace_id, row.barrier_id);
    }
    connection.prepare("UPDATE source_erase_repair_control SET repairing = 0 WHERE singleton = 1").run();
    return true;
  }).immediate();
}
