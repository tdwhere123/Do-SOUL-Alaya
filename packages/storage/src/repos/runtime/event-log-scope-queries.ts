import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  queryBoundedAll as executeBoundedEventLogQuery,
  wrapBoundedQueryError
} from "./event-log-bounded-query.js";
import {
  EVENT_LOG_ALL_QUERY_HARD_MAX,
  type EventLogRow
} from "./event-log-rows.js";
import type { EventLogStatements } from "./event-log-statements.js";

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
    let rows: EventLogRow[];
    let scopeId: string;

    if (scope.kind === "entity") {
      rows = statements.queryByEntityPagedStatement.all(
        scope.entityType,
        scope.entityId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      ) as EventLogRow[];
      scopeId = `${scope.entityType}:${scope.entityId}`;
    } else if (scope.kind === "run") {
      rows = statements.queryByRunPagedStatement.all(
        scope.runId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      ) as EventLogRow[];
      scopeId = scope.runId;
    } else {
      rows = statements.queryByWorkspacePagedStatement.all(
        scope.workspaceId,
        EVENT_LOG_ALL_QUERY_HARD_MAX + 1,
        0
      ) as EventLogRow[];
      scopeId = scope.workspaceId;
    }

    return executeBoundedEventLogQuery(() => rows, scope.kind, scopeId);
  } catch (error) {
    wrapBoundedQueryError(scope.kind, error);
  }
}
