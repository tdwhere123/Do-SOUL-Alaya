import { WorkspaceRunEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { StorageError } from "../../shared/errors.js";
import {
  appendInCurrentTransaction as appendEventLogInTransaction,
  wrapAppendError
} from "./event-log-append.js";
import {
  queryBoundedAll as executeBoundedEventLogQuery,
  wrapBoundedQueryError
} from "./event-log-bounded-query.js";
import {
  CONVERSATION_MESSAGE_EVENT_TYPES,
  DEFAULT_EVENT_LOG_PAGE,
  EVENT_LOG_ALL_QUERY_HARD_MAX,
  parseEventLogEntryRow,
  parseEventLogPage,
  type CountRow,
  type EventLogCursorStateRow,
  type EventLogRow
} from "./event-log-rows.js";
import {
  prepareEventLogStatements,
  type EventLogStatements
} from "./event-log-statements.js";
import {
  executeCountDistinctAppliedSessionOverrideRuns,
  executeHasNarrativeConsolidationTrigger,
  executeHasOpenSessionOverrideCorrection,
  executeHasSecurityHitForTarget,
  executeHasSessionOverridePromotion,
  executeQueryGovernanceLeaseEventsByRun,
  executeQueryNarrativeDigestPayloadsByRun,
  wrapGovernanceQueryError
} from "./event-log-governance-queries.js";
import type { EventLogAppendInput, EventLogPageOptions, EventLogRepo } from "./event-log-types.js";

export type { EventLogAppendInput, EventLogPageOptions, EventLogRepo } from "./event-log-types.js";

export class SqliteEventLogRepo implements EventLogRepo {
  private readonly statementHolder: RefreshableStatementHolder<EventLogStatements>;

  public constructor(private readonly db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareEventLogStatements);
  }

  private activeStatements(): EventLogStatements {
    return this.statementHolder.active();
  }

  public append(event: EventLogAppendInput): EventLogEntry {
    // Always auto-compute revision so the unique index on (entity_type, entity_id, revision) is
    // never violated by callers that hardcode revision: 0 or supply stale MAX+1 values.
    // The SELECT MAX + INSERT pair must be one write transaction even when callers append
    // directly, because multiple CLI/daemon processes can bootstrap against the same DB.
    if (this.db.connection.inTransaction) {
      return this.appendInCurrentTransaction(event);
    }

    const txn = this.db.connection.transaction(() => this.appendInCurrentTransaction(event));
    return txn.immediate();
  }

  public deleteById(eventId: string): void {
    try {
      this.activeStatements().deleteByIdStatement.run(eventId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete event log entry.", error);
    }
  }

  public transactional<T>(fn: () => T): T {
    // better-sqlite3 transactions are synchronous; if `fn` returns a Promise the
    // BEGIN/COMMIT pair completes before the awaited work, which is incorrect.
    // Callers that need async work must do it outside the transaction.
    const txn = this.db.connection.transaction(fn);
    return txn.immediate();
  }

  public async queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]> {
    return await this.queryByEntityPage(entityType, entityId, DEFAULT_EVENT_LOG_PAGE);
  }

  public async queryByEntityAll(entityType: string, entityId: string): Promise<readonly EventLogEntry[]> {
    return await this.queryBoundedAll(
      () =>
        this.activeStatements().queryByEntityPagedStatement.all(
          entityType,
          entityId,
          EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
          0
        ) as EventLogRow[],
      "entity",
      `${entityType}:${entityId}`
    );
  }

  public async queryByEntityPage(
    entityType: string,
    entityId: string,
    page: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.activeStatements().queryByEntityPagedStatement.all(
        entityType,
        entityId,
        parsedPage.limit,
        parsedPage.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query paged event log by entity.", error);
    }
  }

  public async queryByRun(runId: string): Promise<readonly EventLogEntry[]> {
    return await this.queryByRunPage(runId, DEFAULT_EVENT_LOG_PAGE);
  }

  public async queryByRunAll(runId: string): Promise<readonly EventLogEntry[]> {
    return await this.queryBoundedAll(
      () =>
        this.activeStatements().queryByRunPagedStatement.all(
          runId,
          EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
          0
        ) as EventLogRow[],
      "run",
      runId
    );
  }

  public async queryNarrativeDigestPayloadsByRun(
    runId: string
  ): Promise<readonly Readonly<{ readonly payload_json: unknown }>[]> {
    try {
      return executeQueryNarrativeDigestPayloadsByRun(this.activeStatements(), runId);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      wrapGovernanceQueryError("Failed to query narrative digest payloads by run.", error);
    }
  }

  public async queryByRunPage(runId: string, page: EventLogPageOptions): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.activeStatements().queryByRunPagedStatement.all(
        runId,
        parsedPage.limit,
        parsedPage.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query paged event log by run.", error);
    }
  }

  public async queryByRunAndEntityType(
    runId: string,
    entityType: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.activeStatements().queryByRunAndEntityTypeStatement.all(
        runId,
        entityType
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by run and entity type.", error);
    }
  }

  public async queryConversationMessageEventsByRun(
    runId: string,
    page?: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page ?? DEFAULT_EVENT_LOG_PAGE);
    try {
      const rows = this.activeStatements().queryConversationMessageEventsByRunPagedStatement.all(
        runId,
        ...CONVERSATION_MESSAGE_EVENT_TYPES,
        parsedPage.limit,
        parsedPage.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query message events by run.", error);
    }
  }

  public async countConversationMessageEventsByRun(runId: string): Promise<number> {
    try {
      const row = this.activeStatements().countConversationMessageEventsByRunStatement.get(
        runId,
        ...CONVERSATION_MESSAGE_EVENT_TYPES
      ) as CountRow | undefined;
      return row === undefined ? 0 : Number(row.total);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count message events by run.", error);
    }
  }

  public async hasNarrativeConsolidationTrigger(
    runId: string,
    digestCountBefore: number
  ): Promise<boolean> {
    try {
      return executeHasNarrativeConsolidationTrigger(
        this.activeStatements(),
        runId,
        digestCountBefore
      );
    } catch (error) {
      wrapGovernanceQueryError("Failed to query narrative consolidation trigger.", error);
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
      const row = this.activeStatements().queryByRunCursorStateStatement.get(
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
    return await this.queryByWorkspacePage(workspaceId, DEFAULT_EVENT_LOG_PAGE);
  }

  public async queryByWorkspaceAll(workspaceId: string): Promise<readonly EventLogEntry[]> {
    return await this.queryBoundedAll(
      () =>
        this.activeStatements().queryByWorkspacePagedStatement.all(
          workspaceId,
          EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
          0
        ) as EventLogRow[],
      "workspace",
      workspaceId
    );
  }

  public async queryByWorkspacePage(
    workspaceId: string,
    page: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.activeStatements().queryByWorkspacePagedStatement.all(
        workspaceId,
        parsedPage.limit,
        parsedPage.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query paged event log by workspace.", error);
    }
  }

  public async queryByWorkspaceAndType(
    workspaceId: string,
    eventType: string,
    sinceIso?: string,
    untilIso?: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const since = sinceIso ?? null;
      const until = untilIso ?? null;
      const rows = this.activeStatements().queryByWorkspaceAndTypeStatement.all(
        workspaceId,
        eventType,
        since,
        since,
        until,
        until,
        DEFAULT_EVENT_LOG_PAGE.limit,
        DEFAULT_EVENT_LOG_PAGE.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by workspace and type.", error);
    }
  }

  public async hasSessionOverridePromotion(overrideId: string): Promise<boolean> {
    try {
      return executeHasSessionOverridePromotion(this.activeStatements(), overrideId);
    } catch (error) {
      wrapGovernanceQueryError("Failed to query session override promotion audit.", error);
    }
  }

  public async countDistinctAppliedSessionOverrideRuns(query: {
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
  }): Promise<number> {
    try {
      return executeCountDistinctAppliedSessionOverrideRuns(this.activeStatements(), query);
    } catch (error) {
      wrapGovernanceQueryError("Failed to count recurring session override runs.", error);
    }
  }

  public async hasOpenSessionOverrideCorrection(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly nowIso: string;
  }): Promise<boolean> {
    try {
      return executeHasOpenSessionOverrideCorrection(this.activeStatements(), query);
    } catch (error) {
      wrapGovernanceQueryError("Failed to query open session override correction.", error);
    }
  }

  public async hasSecurityHitForTarget(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }): Promise<boolean> {
    try {
      return executeHasSecurityHitForTarget(this.activeStatements(), query);
    } catch (error) {
      wrapGovernanceQueryError("Failed to query green security-hit audit.", error);
    }
  }

  public async queryByRunAfterEventId(
    runId: string,
    lastEventId: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.activeStatements().queryByRunAfterEventIdStatement.all(
        runId,
        runId,
        lastEventId,
        DEFAULT_EVENT_LOG_PAGE.limit,
        DEFAULT_EVENT_LOG_PAGE.offset
      ) as EventLogRow[];
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
      const rows = this.activeStatements().queryByWorkspaceAfterEventIdStatement.all(
        workspaceId,
        workspaceId,
        lastEventId,
        DEFAULT_EVENT_LOG_PAGE.limit,
        DEFAULT_EVENT_LOG_PAGE.offset
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
      const rows = this.activeStatements().queryByTypeStatement.all(
        eventType,
        DEFAULT_EVENT_LOG_PAGE.limit,
        DEFAULT_EVENT_LOG_PAGE.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by type.", error);
    }
  }

  public async getLatestEventId(runId: string): Promise<string | null> {
    try {
      const row = this.activeStatements().getLatestEventIdStatement.get(runId) as
        | { readonly event_id: string }
        | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest event ID.", error);
    }
  }

  public async getLatestMessageTimestampByRun(runId: string): Promise<string | null> {
    try {
      const row = this.activeStatements().getLatestMessageTimestampByRunStatement.get(
        runId,
        ...CONVERSATION_MESSAGE_EVENT_TYPES
      ) as { readonly created_at: string } | undefined;
      return row?.created_at ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest message timestamp by run.", error);
    }
  }

  public async getLatestUserRunMessageByRun(runId: string): Promise<EventLogEntry | null> {
    try {
      const row = this.activeStatements().getLatestUserRunMessageByRunStatement.get(
        runId,
        WorkspaceRunEventType.RUN_MESSAGE_APPENDED
      ) as EventLogRow | undefined;
      return row === undefined ? null : parseEventLogEntryRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest user run message.", error);
    }
  }

  public async queryByRunAndEventType(
    runId: string,
    eventType: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.activeStatements().queryByRunAndEventTypeStatement.all(runId, eventType) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query event log by run and event type.", error);
    }
  }

  public async queryGovernanceLeaseEventsByRun(runId: string): Promise<readonly EventLogEntry[]> {
    try {
      return executeQueryGovernanceLeaseEventsByRun(this.activeStatements(), runId);
    } catch (error) {
      wrapGovernanceQueryError("Failed to query governance lease events by run.", error);
    }
  }

  public async getLatestWorkspaceEventId(workspaceId: string): Promise<string | null> {
    try {
      const row = this.activeStatements().getLatestWorkspaceEventIdStatement.get(workspaceId) as
        | { readonly event_id: string }
        | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest workspace event ID.", error);
    }
  }

  private async queryBoundedAll(
    loadRows: () => EventLogRow[],
    scopeKind: "entity" | "run" | "workspace",
    scopeId: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      return executeBoundedEventLogQuery(loadRows, scopeKind, scopeId);
    } catch (error) {
      wrapBoundedQueryError(scopeKind, error);
    }
  }

  private appendInCurrentTransaction(event: EventLogAppendInput): EventLogEntry {
    try {
      return appendEventLogInTransaction(this.activeStatements(), event);
    } catch (error) {
      wrapAppendError(error);
    }
  }
}
