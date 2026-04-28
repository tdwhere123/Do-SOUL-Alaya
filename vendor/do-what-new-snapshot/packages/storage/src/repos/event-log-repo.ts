import { randomUUID } from "node:crypto";
import { EventLogEntrySchema, type EventLogEntry } from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

/**
 * Caller-facing input for appending an event.
 * `revision` may be supplied for compatibility with existing callers but is
 * always ignored — SqliteEventLogRepo auto-computes MAX(revision)+1 so that
 * the unique index on (entity_type, entity_id, revision) is never violated.
 */
export type EventLogAppendInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision"> & {
  readonly revision?: number;
};

export interface EventLogRepo {
  append(event: EventLogAppendInput): Promise<EventLogEntry>;
  deleteById(eventId: string): Promise<void>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
  queryByRunCursorState(
    runId: string,
    lastEventId: string | null
  ): Promise<{
    readonly cursorExists: boolean;
    readonly eventsUpToCursor: number;
    readonly latestEventId: string | null;
  }>;
  queryByWorkspace(workspaceId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAfterEventId(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspaceAfterEventId(workspaceId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByType(eventType: string): Promise<readonly EventLogEntry[]>;
  getLatestEventId(runId: string): Promise<string | null>;
  getLatestWorkspaceEventId(workspaceId: string): Promise<string | null>;
}

interface EventLogRow {
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

interface EventLogEntryCandidate {
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

interface EventLogCursorStateRow {
  readonly cursor_exists: number;
  readonly events_up_to_cursor: number;
  readonly latest_event_id: string | null;
}

export class SqliteEventLogRepo implements EventLogRepo {
  private readonly appendStatement;
  private readonly deleteByIdStatement;
  private readonly queryByEntityStatement;
  private readonly queryByRunStatement;
  private readonly queryByRunCursorStateStatement;
  private readonly queryByWorkspaceStatement;
  private readonly queryByRunAfterEventIdStatement;
  private readonly queryByWorkspaceAfterEventIdStatement;
  private readonly queryByTypeStatement;
  private readonly nextRevisionStatement;
  private readonly getLatestEventIdStatement;
  private readonly getLatestWorkspaceEventIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.appendStatement = db.connection.prepare(`
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
    `);
    this.deleteByIdStatement = db.connection.prepare(`
      DELETE FROM event_log WHERE event_id = ?
    `);
    this.queryByEntityStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    this.queryByRunStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE run_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    this.queryByRunCursorStateStatement = db.connection.prepare(`
      SELECT
        EXISTS(
          SELECT 1
          FROM event_log
          WHERE run_id = ? AND event_id = ?
          LIMIT 1
        ) AS cursor_exists,
        COALESCE((
          SELECT COUNT(*)
          FROM event_log
          WHERE run_id = ?
            AND rowid <= (
              SELECT rowid
              FROM event_log
              WHERE run_id = ? AND event_id = ?
              LIMIT 1
            )
        ), 0) AS events_up_to_cursor,
        (
          SELECT event_id
          FROM event_log
          WHERE run_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        ) AS latest_event_id
    `);
    this.queryByWorkspaceStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE workspace_id = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    this.queryByRunAfterEventIdStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE run_id = ?
        AND rowid > COALESCE((
          SELECT rowid
          FROM event_log
          WHERE run_id = ? AND event_id = ?
          LIMIT 1
        ), 0)
      ORDER BY created_at ASC, rowid ASC
    `);
    this.queryByWorkspaceAfterEventIdStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE workspace_id = ?
        AND rowid > COALESCE((
          SELECT rowid
          FROM event_log
          WHERE workspace_id = ? AND event_id = ?
          LIMIT 1
        ), 0)
      ORDER BY created_at ASC, rowid ASC
    `);
    this.queryByTypeStatement = db.connection.prepare(`
      SELECT
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
      FROM event_log
      WHERE event_type = ?
      ORDER BY created_at ASC, rowid ASC
    `);
    this.nextRevisionStatement = db.connection.prepare(`
      SELECT MAX(revision) AS max_revision
      FROM event_log
      WHERE entity_type = ? AND entity_id = ?
    `);
    this.getLatestEventIdStatement = db.connection.prepare(`
      SELECT event_id
      FROM event_log
      WHERE run_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `);
    this.getLatestWorkspaceEventIdStatement = db.connection.prepare(`
      SELECT event_id
      FROM event_log
      WHERE workspace_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `);
  }

  public async append(event: EventLogAppendInput): Promise<EventLogEntry> {
    // Always auto-compute revision so the unique index on (entity_type, entity_id, revision) is
    // never violated by callers that hardcode revision: 0 or supply stale MAX+1 values.
    const revision = this.computeNextRevision(event.entity_type, event.entity_id);

    const entry = parseEventLogEntry({
      ...event,
      event_id: randomUUID(),
      revision,
      created_at: new Date().toISOString()
    });

    try {
      this.appendStatement.run(
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

  public async deleteById(eventId: string): Promise<void> {
    try {
      this.deleteByIdStatement.run(eventId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete event log entry.", error);
    }
  }

  public async queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByEntityStatement.all(entityType, entityId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by entity.", error);
    }
  }

  public async queryByRun(runId: string): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByRunStatement.all(runId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by run.", error);
    }
  }

  public async queryByRunCursorState(
    runId: string,
    lastEventId: string | null
  ): Promise<{
    readonly cursorExists: boolean;
    readonly eventsUpToCursor: number;
    readonly latestEventId: string | null;
  }> {
    try {
      const row = this.queryByRunCursorStateStatement.get(
        runId,
        lastEventId,
        runId,
        runId,
        lastEventId,
        runId
      ) as EventLogCursorStateRow | undefined;

      return Object.freeze({
        cursorExists: Number(row?.cursor_exists ?? 0) > 0,
        eventsUpToCursor: row?.events_up_to_cursor ?? 0,
        latestEventId: row?.latest_event_id ?? null
      });
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log cursor state.", error);
    }
  }

  public async queryByWorkspace(workspaceId: string): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByWorkspaceStatement.all(workspaceId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by workspace.", error);
    }
  }

  public async queryByRunAfterEventId(
    runId: string,
    lastEventId: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByRunAfterEventIdStatement.all(runId, runId, lastEventId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by run after event ID.", error);
    }
  }

  public async queryByWorkspaceAfterEventId(
    workspaceId: string,
    lastEventId: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByWorkspaceAfterEventIdStatement.all(
        workspaceId,
        workspaceId,
        lastEventId
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to query event log by workspace after event ID.",
        error
      );
    }
  }

  public async queryByType(eventType: string): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.queryByTypeStatement.all(eventType) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by type.", error);
    }
  }

  public async getLatestEventId(runId: string): Promise<string | null> {
    try {
      const row = this.getLatestEventIdStatement.get(runId) as { readonly event_id: string } | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest event ID.", error);
    }
  }

  public async getLatestWorkspaceEventId(workspaceId: string): Promise<string | null> {
    try {
      const row = this.getLatestWorkspaceEventIdStatement.get(workspaceId) as
        | { readonly event_id: string }
        | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest workspace event ID.", error);
    }
  }

  private computeNextRevision(entityType: string, entityId: string): number {
    try {
      const row = this.nextRevisionStatement.get(entityType, entityId) as
        | { readonly max_revision: number | null }
        | undefined;
      return (row?.max_revision ?? -1) + 1;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to compute next event log revision.", error);
    }
  }
}

function parseEventLogEntryRow(row: EventLogRow): EventLogEntry {
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

function parseEventLogEntry(entry: EventLogEntryCandidate): EventLogEntry {
  try {
    return EventLogEntrySchema.parse(entry);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate event log entry.", error);
  }
}
