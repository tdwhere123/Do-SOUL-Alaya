import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { parseRows } from "../../../shared/parse-row.js";
import { wrapBoundedQueryError } from "./event-log-bounded-query.js";
import {
  EVENT_LOG_ALL_QUERY_HARD_MAX,
  EventLogEntryRowParser,
  enforceEventLogAllHardCap
} from "../mappers/event-log-rows.js";
import type { EventLogStatements } from "../statements/event-log-statements.js";

type EventLogScope =
  | { readonly kind: "entity"; readonly entityType: string; readonly entityId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export function queryEventLogScopeAll(
  loadStatements: () => EventLogStatements,
  scope: EventLogScope
): readonly EventLogEntry[] {
  try {
    const statements = loadStatements();
    let rawRows: unknown;
    let scopeId: string;

    if (scope.kind === "entity") {
      rawRows = statements.queryByEntityPagedStatement.all(
        scope.entityType,
        scope.entityId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      );
      scopeId = `${scope.entityType}:${scope.entityId}`;
    } else if (scope.kind === "run") {
      rawRows = statements.queryByRunPagedStatement.all(
        scope.runId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      );
      scopeId = scope.runId;
    } else {
      rawRows = statements.queryByWorkspacePagedStatement.all(
        scope.workspaceId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      );
      scopeId = scope.workspaceId;
    }

    return enforceEventLogAllHardCap(
      parseRows(rawRows, EventLogEntryRowParser, "event log row"),
      scope.kind,
      scopeId
    );
  } catch (error) {
    wrapBoundedQueryError(scope.kind, error);
  }
}
