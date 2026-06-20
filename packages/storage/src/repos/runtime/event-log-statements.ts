import type { StorageDatabase } from "../../sqlite/db.js";
import {
  prepareEventLogEntityQueryStatements,
  prepareEventLogGovernancePredicateStatements,
  prepareEventLogMutationStatements,
  prepareEventLogRevisionStatements,
  prepareEventLogRunQueryStatements,
  prepareEventLogWorkspaceQueryStatements,
  type EventLogEntityQueryStatements,
  type EventLogGovernancePredicateStatements,
  type EventLogMutationStatements,
  type EventLogRevisionStatements,
  type EventLogRunQueryStatements,
  type EventLogWorkspaceQueryStatements
} from "./event-log-statement-groups.js";

export type { SqliteStatement } from "./event-log-statement-groups.js";

export interface EventLogStatements
  extends EventLogMutationStatements,
    EventLogEntityQueryStatements,
    EventLogRunQueryStatements,
    EventLogWorkspaceQueryStatements,
    EventLogGovernancePredicateStatements,
    EventLogRevisionStatements {}

export function prepareEventLogStatements(db: StorageDatabase): EventLogStatements {
  return {
    ...prepareEventLogMutationStatements(db),
    ...prepareEventLogEntityQueryStatements(db),
    ...prepareEventLogRunQueryStatements(db),
    ...prepareEventLogWorkspaceQueryStatements(db),
    ...prepareEventLogGovernancePredicateStatements(db),
    ...prepareEventLogRevisionStatements(db)
  };
}
