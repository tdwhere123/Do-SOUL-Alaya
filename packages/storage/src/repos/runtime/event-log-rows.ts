import {
  EventLogEntrySchema,
  StreamingEventType,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { DEFAULT_REPO_LIST_PAGE_LIMIT, parsePageLimit, parsePageOffset } from "../shared/validators.js";
import type { EventLogPageOptions } from "./event-log-types.js";

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

export function parseEventLogEntryRow(row: EventLogRow): EventLogEntry {
  let payload: unknown;

  try {
    payload = JSON.parse(row.payload_json);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse event payload JSON.", error);
  }

  return parseEventLogEntry({
    ...row,
    payload_json: payload
  });
}

export function parseEventLogEntry(entry: EventLogEntryCandidate): EventLogEntry {
  try {
    return EventLogEntrySchema.parse(entry);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate event log entry.", error);
  }
}

export function parseEventLogPage(page: EventLogPageOptions): Readonly<EventLogPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "event log page limit"),
    offset: parsePageOffset(page.offset, "event log page offset")
  });
}
