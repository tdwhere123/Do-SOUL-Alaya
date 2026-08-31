import { randomUUID } from "node:crypto";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import type { SqliteWriteQueuePort, SqliteWriteStatement } from "../../../../sqlite/write-queue/port.js";
import { StorageError } from "../../../../shared/errors.js";
import {
  EVENT_LOG_APPEND_WITH_REVISION_SQL,
  EVENT_LOG_GET_BY_ID_SQL
} from "../statements/append-sql.js";
import { parseEventLogEntry, parseEventLogEntryRow, type EventLogRow } from "../mappers/event-log-rows.js";
import type { EventLogAppendInput } from "../../event-log-types.js";

export {
  EVENT_LOG_APPEND_WITH_REVISION_SQL,
  EVENT_LOG_GET_BY_ID_SQL,
  EVENT_LOG_SELECT_COLUMNS
} from "../statements/append-sql.js";

export function buildEventLogAppendPayloadStatement(
  event: EventLogAppendInput,
  identities: { readonly eventId: string; readonly createdAt: string }
): SqliteWriteStatement {
  // Validate envelope fields before crossing the worker boundary; revision is
  // provisional here and replaced by the worker subquery.
  parseEventLogEntry({
    ...event,
    event_id: identities.eventId,
    revision: 0,
    created_at: identities.createdAt
  });

  return {
    sql: EVENT_LOG_APPEND_WITH_REVISION_SQL,
    params: [
      identities.eventId,
      event.event_type,
      event.entity_type,
      event.entity_id,
      event.workspace_id,
      event.run_id,
      event.caused_by,
      event.entity_type,
      event.entity_id,
      JSON.stringify(event.payload_json),
      identities.createdAt
    ]
  };
}

export async function appendEventLogViaWriteQueue(
  db: StorageDatabase,
  queue: SqliteWriteQueuePort,
  event: EventLogAppendInput
): Promise<EventLogEntry> {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const statement = buildEventLogAppendPayloadStatement(event, { eventId, createdAt });

  try {
    await queue.enqueue({
      jobId: `event_log_append:${eventId}`,
      kind: "event_log_transaction",
      filename: db.filename,
      payload: { statements: [statement] }
    });
  } catch (error) {
    throw new StorageError("QUERY_FAILED", "Failed to append event log entry via write queue.", error);
  }

  return readCommittedEventLogEntry(db, eventId);
}

function readCommittedEventLogEntry(db: StorageDatabase, eventId: string): EventLogEntry {
  try {
    const row = db.connection.prepare(EVENT_LOG_GET_BY_ID_SQL).get(eventId) as EventLogRow | undefined;
    if (row === undefined) {
      throw new StorageError(
        "QUERY_FAILED",
        `Event log entry ${eventId} missing after write-queue commit.`
      );
    }
    return parseEventLogEntryRow(row);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("QUERY_FAILED", "Failed to read event log entry after write-queue commit.", error);
  }
}
