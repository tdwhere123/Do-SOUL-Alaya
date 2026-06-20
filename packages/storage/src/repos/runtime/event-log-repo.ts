import { randomUUID } from "node:crypto";
import {
  GreenGovernanceEventType,
  ObligationTrustNarrativeEventType,
  RevokeReason,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  CONVERSATION_MESSAGE_EVENT_TYPES,
  DEFAULT_EVENT_LOG_PAGE,
  parseEventLogEntry,
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
import type { EventLogAppendInput, EventLogPageOptions, EventLogRepo } from "./event-log-types.js";

export type { EventLogAppendInput, EventLogPageOptions, EventLogRepo } from "./event-log-types.js";

type ExistsRow = { readonly found: number };

export class SqliteEventLogRepo implements EventLogRepo {
  private readonly statements: EventLogStatements;

  public constructor(private readonly db: StorageDatabase) {
    this.statements = prepareEventLogStatements(db);
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
      this.statements.deleteByIdStatement.run(eventId);
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
    try {
      const rows = this.statements.queryByEntityStatement.all(entityType, entityId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query full event log by entity.", error);
    }
  }

  public async queryByEntityPage(
    entityType: string,
    entityId: string,
    page: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.statements.queryByEntityPagedStatement.all(
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
    try {
      const rows = this.statements.queryByRunStatement.all(runId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query full event log by run.", error);
    }
  }

  public async queryByRunPage(runId: string, page: EventLogPageOptions): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.statements.queryByRunPagedStatement.all(
        runId,
        parsedPage.limit,
        parsedPage.offset
      ) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query paged event log by run.", error);
    }
  }

  public async queryConversationMessageEventsByRun(
    runId: string,
    page?: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page ?? DEFAULT_EVENT_LOG_PAGE);
    try {
      const rows = this.statements.queryConversationMessageEventsByRunPagedStatement.all(
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
      const row = this.statements.countConversationMessageEventsByRunStatement.get(
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
      const row = this.statements.hasNarrativeConsolidationTriggerStatement.get(
        runId,
        ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
        digestCountBefore
      ) as ExistsRow | undefined;
      return Number(row?.found ?? 0) > 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query narrative consolidation trigger.", error);
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
      const row = this.statements.queryByRunCursorStateStatement.get(
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
    try {
      const rows = this.statements.queryByWorkspaceStatement.all(workspaceId) as EventLogRow[];
      return rows.map((row) => parseEventLogEntryRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query full event log by workspace.", error);
    }
  }

  public async queryByWorkspacePage(
    workspaceId: string,
    page: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]> {
    const parsedPage = parseEventLogPage(page);

    try {
      const rows = this.statements.queryByWorkspacePagedStatement.all(
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
      const rows = this.statements.queryByWorkspaceAndTypeStatement.all(
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
      const row = this.statements.hasSessionOverridePromotionStatement.get(
        overrideId,
        GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED
      ) as ExistsRow | undefined;
      return Number(row?.found ?? 0) > 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query session override promotion audit.", error);
    }
  }

  public async countDistinctAppliedSessionOverrideRuns(query: {
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
  }): Promise<number> {
    try {
      const row = this.statements.countDistinctAppliedSessionOverrideRunsStatement.get(
        query.workspaceId,
        GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
        normalizeEventLogText(query.targetObject),
        normalizeEventLogText(query.correction)
      ) as CountRow | undefined;
      return row === undefined ? 0 : Number(row.total);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count recurring session override runs.", error);
    }
  }

  public async hasOpenSessionOverrideCorrection(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly nowIso: string;
  }): Promise<boolean> {
    try {
      const row = this.statements.hasOpenSessionOverrideCorrectionStatement.get(
        query.workspaceId,
        GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
        query.targetObjectId,
        query.nowIso,
        GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED
      ) as ExistsRow | undefined;
      return Number(row?.found ?? 0) > 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query open session override correction.", error);
    }
  }

  public async hasSecurityHitForTarget(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }): Promise<boolean> {
    try {
      const row = this.statements.hasSecurityHitForTargetStatement.get(
        query.targetObjectId,
        RevokeReason.SECURITY_HIT,
        query.workspaceId,
        GreenGovernanceEventType.SOUL_GREEN_PIERCED,
        query.targetObjectId,
        RevokeReason.SECURITY_HIT
      ) as ExistsRow | undefined;
      return Number(row?.found ?? 0) > 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to query green security-hit audit.", error);
    }
  }

  public async queryByRunAfterEventId(
    runId: string,
    lastEventId: string
  ): Promise<readonly EventLogEntry[]> {
    try {
      const rows = this.statements.queryByRunAfterEventIdStatement.all(
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
      const rows = this.statements.queryByWorkspaceAfterEventIdStatement.all(
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
      const rows = this.statements.queryByTypeStatement.all(
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
      const row = this.statements.getLatestEventIdStatement.get(runId) as
        | { readonly event_id: string }
        | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest event ID.", error);
    }
  }

  public async getLatestWorkspaceEventId(workspaceId: string): Promise<string | null> {
    try {
      const row = this.statements.getLatestWorkspaceEventIdStatement.get(workspaceId) as
        | { readonly event_id: string }
        | undefined;
      return row?.event_id ?? null;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to get latest workspace event ID.", error);
    }
  }

  private appendInCurrentTransaction(event: EventLogAppendInput): EventLogEntry {
    const revision = this.computeNextRevision(event.entity_type, event.entity_id);
    const entry = parseEventLogEntry({
      ...event,
      event_id: randomUUID(),
      revision,
      created_at: new Date().toISOString()
    });

    try {
      this.statements.appendStatement.run(
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

  private computeNextRevision(entityType: string, entityId: string): number {
    try {
      const row = this.statements.nextRevisionStatement.get(entityType, entityId) as
        | { readonly max_revision: number | null }
        | undefined;
      return (row?.max_revision ?? -1) + 1;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to compute next event log revision.", error);
    }
  }
}

function normalizeEventLogText(value: string): string {
  return value.trim().toLowerCase();
}
