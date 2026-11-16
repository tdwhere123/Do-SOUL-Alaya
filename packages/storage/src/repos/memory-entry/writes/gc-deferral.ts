import { canonicalJson, EventLogEntrySchema, type EventLogEntry, type MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { parseMemoryEntryRow, type MemoryEntryRow } from "../mappers/row-mapper.js";

/** Core owns the refusal. Persist it once for the exact inspected revision, with its audit.
 * A subsequent member mutation withdraws the deferral so a new revision can be evaluated.
 */
export function deferAutonomousGc(database: StorageDatabase, expected: MemoryEntry,
  onDeferred: () => EventLogEntry): EventLogEntry | null {
  return database.connection.transaction(() => {
    const row = database.connection.prepare("SELECT * FROM memory_entries WHERE workspace_id=? AND object_id=? AND retention_state='tombstoned' AND updated_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')")
      .get(expected.workspace_id, expected.object_id) as MemoryEntryRow | undefined;
    if (row === undefined || canonicalJson(parseMemoryEntryRow(row)) !== canonicalJson(expected)) return null;
    if (database.connection.prepare("SELECT 1 FROM memory_gc_deferrals WHERE workspace_id=? AND memory_id=?")
      .get(expected.workspace_id, expected.object_id) !== undefined) return null;
    const event = EventLogEntrySchema.parse(onDeferred());
    if (event.workspace_id !== expected.workspace_id || event.entity_id !== expected.object_id ||
        event.event_type !== "soul.memory.state_changed" || event.entity_type !== "memory_entry" ||
        database.connection.prepare("SELECT 1 FROM event_log WHERE event_id=?").get(event.event_id) === undefined) {
      throw new StorageError("CONFLICT", "GC deferral requires its owning audit");
    }
    database.connection.prepare("INSERT INTO memory_gc_deferrals(workspace_id,memory_id,audit_event_id) VALUES(?,?,?)")
      .run(expected.workspace_id, expected.object_id, event.event_id);
    return event;
  }).immediate();
}
