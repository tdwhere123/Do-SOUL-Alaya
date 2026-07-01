import type { EventLogEntry } from "@do-soul/alaya-protocol";

export type EventLogAppendInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface EventLogRepo {
  append(event: EventLogAppendInput): EventLogEntry;
  deleteById(eventId: string): void;
  transactional<T>(fn: () => T): T;
  queryByEntityPage?(
    entityType: string,
    entityId: string,
    page: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByEntityAll(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByRunPage?(runId: string, page: EventLogPageOptions): Promise<readonly EventLogEntry[]>;
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAll(runId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAndEntityType(runId: string, entityType: string): Promise<readonly EventLogEntry[]>;
  queryConversationMessageEventsByRun(
    runId: string,
    page?: EventLogPageOptions
  ): Promise<readonly EventLogEntry[]>;
  countConversationMessageEventsByRun(runId: string): Promise<number>;
  hasNarrativeConsolidationTrigger(runId: string, digestCountBefore: number): Promise<boolean>;
  queryByRunCursorState(
    runId: string,
    lastEventId: string | null
  ): Promise<{
    readonly cursorExists: boolean;
    readonly eventsUpToCursor: number;
    readonly latestEventId: string | null;
  }>;
  queryByWorkspacePage?(workspaceId: string, page: EventLogPageOptions): Promise<readonly EventLogEntry[]>;
  queryByWorkspace(workspaceId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspaceAll(workspaceId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspaceAndType(
    workspaceId: string,
    eventType: string,
    sinceIso?: string,
    untilIso?: string
  ): Promise<readonly EventLogEntry[]>;
  hasSessionOverridePromotion(overrideId: string): Promise<boolean>;
  countDistinctAppliedSessionOverrideRuns(query: {
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
  }): Promise<number>;
  hasOpenSessionOverrideCorrection(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly nowIso: string;
  }): Promise<boolean>;
  hasSecurityHitForTarget(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }): Promise<boolean>;
  queryByRunAfterEventId(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspaceAfterEventId(workspaceId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByType(eventType: string): Promise<readonly EventLogEntry[]>;
  getLatestEventId(runId: string): Promise<string | null>;
  getLatestMessageTimestampByRun(runId: string): Promise<string | null>;
  getLatestUserRunMessageByRun(runId: string): Promise<EventLogEntry | null>;
  queryByRunAndEventType(runId: string, eventType: string): Promise<readonly EventLogEntry[]>;
  queryGovernanceLeaseEventsByRun(runId: string): Promise<readonly EventLogEntry[]>;
  getLatestWorkspaceEventId(workspaceId: string): Promise<string | null>;
}

export interface EventLogPageOptions {
  readonly limit: number;
  readonly offset: number;
}
