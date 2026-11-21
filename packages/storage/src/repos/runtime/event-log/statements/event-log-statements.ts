import type { StorageDatabase } from "../../../../sqlite/db.js";
import {
  prepareEventLogEntityQueryStatements,
  prepareEventLogGovernancePredicateStatements,
  prepareEventLogMutationStatements,
  prepareEventLogRunQueryStatements,
  prepareEventLogWorkspaceQueryStatements,
  type EventLogEntityQueryStatements,
  type EventLogGovernancePredicateStatements,
  type EventLogMutationStatements,
  type EventLogRunQueryStatements,
  type EventLogWorkspaceQueryStatements
} from "./event-log-statement-groups.js";

export type { SqliteStatement } from "./event-log-statement-groups.js";

export interface EventLogStatements
  extends EventLogMutationStatements,
    EventLogEntityQueryStatements,
    EventLogRunQueryStatements,
    EventLogWorkspaceQueryStatements,
    EventLogGovernancePredicateStatements {}

export function prepareEventLogStatements(db: StorageDatabase): EventLogStatements {
  return {
    ...prepareEventLogMutationStatements(db),
    ...prepareEventLogEntityQueryStatements(db),
    ...prepareEventLogRunQueryStatements(db),
    ...prepareEventLogWorkspaceQueryStatements(db),
    ...prepareEventLogGovernancePredicateStatements(db)
  };
}
