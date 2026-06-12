import { randomUUID } from "node:crypto";
import { EventLogEntrySchema, type EventLogEntry } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export type EventLogDraftInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

interface EventLogInsertStatement {
  run(...args: readonly unknown[]): unknown;
}

interface EventLogNextRevisionStatement {
  get(...args: readonly unknown[]): unknown;
}

interface EventLogWriter {
  readonly appendStatement: EventLogInsertStatement;
  readonly nextRevisionStatement: EventLogNextRevisionStatement;
}

const eventLogWriterCache = new WeakMap<SqliteConnection, EventLogWriter>();

export function getEventLogWriter(connection: SqliteConnection): EventLogWriter {
  const cached = eventLogWriterCache.get(connection);

  if (cached !== undefined) {
    return cached;
  }

  const writer: EventLogWriter = {
    appendStatement: connection.prepare(`
      INSERT INTO event_log (
        event_id,
        event_type,
        entity_type,
        entity_id,
        workspace_id,
        run_id,
        caused_by,
        revision,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    nextRevisionStatement: connection.prepare(`
      SELECT MAX(revision) AS max_revision
      FROM event_log
      WHERE entity_type = ? AND entity_id = ?
    `)
  };

  eventLogWriterCache.set(connection, writer);
  return writer;
}

export function insertEventLogEntry(
  writer: EventLogWriter,
  event: EventLogDraftInput
): EventLogEntry {
  const entry = parseEventLogEntry({
    ...event,
    event_id: randomUUID(),
    revision: getNextRevision(writer, event.entity_type, event.entity_id),
    created_at: new Date().toISOString()
  });

  try {
    writer.appendStatement.run(
      entry.event_id,
      entry.event_type,
      entry.entity_type,
      entry.entity_id,
      entry.workspace_id,
      entry.run_id,
      entry.caused_by,
      entry.revision,
      JSON.stringify(entry.payload_json),
      entry.created_at
    );
  } catch (error) {
    throw new StorageError("QUERY_FAILED", "Failed to append event log entry.", error);
  }

  return entry;
}

function getNextRevision(writer: EventLogWriter, entityType: string, entityId: string): number {
  try {
    const row = writer.nextRevisionStatement.get(entityType, entityId) as
      | { readonly max_revision: number | null }
      | undefined;

    return (row?.max_revision ?? -1) + 1;
  } catch (error) {
    throw new StorageError("QUERY_FAILED", "Failed to compute next event log revision.", error);
  }
}

function parseEventLogEntry(entry: EventLogEntry): EventLogEntry {
  try {
    return EventLogEntrySchema.parse(entry);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate event log entry.", error);
  }
}
