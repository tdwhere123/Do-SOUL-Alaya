import { randomUUID } from "node:crypto";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { EVENT_LOG_APPEND_SYNC_SQL } from "../event-log/statements/append-sql.js";
import { parseEventLogEntry } from "../event-log/mappers/event-log-rows.js";
import { assertEventLogWriteScope } from "../event-log/writes/synchronous-transaction.js";

export type EventLogDraftInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

interface EventLogInsertStatement {
  run(...args: readonly unknown[]): unknown;
}

interface EventLogNextRevisionStatement {
  get(...args: readonly unknown[]): unknown;
}

interface EventLogWriter {
  readonly connection: SqliteConnection;
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
    connection,
    appendStatement: connection.prepare(EVENT_LOG_APPEND_SYNC_SQL),
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
  assertEventLogWriteScope();
  if (!writer.connection.inTransaction) {
    throw new StorageError("VALIDATION_FAILED", "EventLog append requires an active transaction.");
  }
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
