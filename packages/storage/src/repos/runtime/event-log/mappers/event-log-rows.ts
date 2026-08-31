import {
  EventLogEntrySchema,
  StreamingEventType,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../../shared/errors.js";
import {
  parseRows,
  readJsonColumn,
  readNonEmptyStringField,
  readNonNegativeIntField,
  readNullableStringField,
  readRecord,
  type RowParser
} from "../../../shared/parse-row.js";
import { DEFAULT_REPO_LIST_PAGE_LIMIT, parsePageLimit, parsePageOffset } from "../../../shared/validators.js";
import type { EventLogPageOptions } from "../../event-log-types.js";

export interface EventLogRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: string;
  readonly created_at: string;
}

export interface EventLogEntryCandidate {
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: unknown;
  readonly created_at: string;
}

export interface EventLogCursorStateRow {
  readonly cursor_exists: number;
  readonly events_up_to_cursor: number;
  readonly latest_event_id: string | null;
}

export interface CountRow {
  readonly total: number;
}

export const DEFAULT_EVENT_LOG_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

/** Hard ceiling for explicit `*All` event-log reads; exceeds throw instead of OOM. */
export const EVENT_LOG_ALL_QUERY_HARD_MAX = 10_000;

export function enforceEventLogAllHardCap<T>(
  rows: readonly T[],
  scopeKind: "entity" | "run" | "workspace",
  scopeId: string
): readonly T[] {
  if (rows.length > EVENT_LOG_ALL_QUERY_HARD_MAX) {
    throw new StorageError(
      "QUERY_FAILED",
      `Event log ${scopeKind} history for ${scopeId} exceeds the hard cap of ${EVENT_LOG_ALL_QUERY_HARD_MAX} events. Use paged queries instead.`
    );
  }
  return rows;
}

export const CONVERSATION_MESSAGE_EVENT_TYPES = [
  WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
  WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
  StreamingEventType.MESSAGE_COMPLETED
] as const;

export const EventLogEntryRowParser: RowParser<EventLogEntry> = {
  parse: parseEventLogEntryRow
};

export function parseEventLogEntryRow(value: unknown): EventLogEntry {
  const row = readRecord(value, "event log row");
  return parseEventLogEntry({
    event_id: row.event_id,
    event_type: row.event_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    caused_by: row.caused_by,
    revision: row.revision,
    payload_json: readJsonColumn(row, "payload_json"),
    created_at: row.created_at
  });
}

export function parseEventLogEntry(entry: unknown): EventLogEntry {
  try {
    return EventLogEntrySchema.parse(entry);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate event log entry.", error);
  }
}

export const EventLogCursorStateRowParser: RowParser<EventLogCursorStateRow> = {
  parse(value: unknown): EventLogCursorStateRow {
    const record = readRecord(value, "event log cursor state row");
    return {
      cursor_exists: readNonNegativeIntField(record, "cursor_exists"),
      events_up_to_cursor: readNonNegativeIntField(record, "events_up_to_cursor"),
      latest_event_id: readNullableStringField(record, "latest_event_id")
    };
  }
};

export const EventIdRowParser: RowParser<Readonly<{ readonly event_id: string }>> = {
  parse(value: unknown): Readonly<{ readonly event_id: string }> {
    const record = readRecord(value, "event id row");
    return { event_id: readNonEmptyStringField(record, "event_id") };
  }
};

export const CreatedAtRowParser: RowParser<Readonly<{ readonly created_at: string }>> = {
  parse(value: unknown): Readonly<{ readonly created_at: string }> {
    const record = readRecord(value, "created at row");
    return { created_at: readNonEmptyStringField(record, "created_at") };
  }
};

export function wrapEventLogQueryError(message: string, error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("QUERY_FAILED", message, error);
}

export function queryEventLogRows(values: unknown, message: string): readonly EventLogEntry[] {
  try {
    return parseRows(values, EventLogEntryRowParser, "event log row");
  } catch (error) {
    throw wrapEventLogQueryError(message, error);
  }
}

export function parseEventLogPage(page: EventLogPageOptions): Readonly<EventLogPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "event log page limit"),
    offset: parsePageOffset(page.offset, "event log page offset")
  });
}
