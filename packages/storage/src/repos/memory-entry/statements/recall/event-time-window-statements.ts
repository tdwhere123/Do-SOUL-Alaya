import type { StorageDatabase } from "../../../../sqlite/db.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../../mappers/row-mapper.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "../statement-group-utils.js";
import { MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL } from
  "../../semantic-tie-order.js";
import { ACTIVE_MEMORY_FILTER_SQL } from "./active-memory-filter-sql.js";

export interface RecallEventTimeWindowStatements {
  readonly findByEventTimeWindowStatement: SqliteStatement;
}

const RECALL_EVENT_TIME_WINDOW_SQL: SqlDefinitionMap<RecallEventTimeWindowStatements> = {
  findByEventTimeWindowStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND storage_tier = ?
        AND event_time_start IS NOT NULL
        AND julianday(event_time_start) IS NOT NULL
        AND (event_time_end IS NULL OR julianday(event_time_end) IS NOT NULL)
        AND MIN(
          julianday(event_time_start),
          COALESCE(julianday(event_time_end), julianday(event_time_start))
        ) <= julianday(?)
        AND MAX(
          julianday(event_time_start),
          COALESCE(julianday(event_time_end), julianday(event_time_start))
        ) >= julianday(?)
${ACTIVE_MEMORY_FILTER_SQL}      ORDER BY ROUND(COALESCE(activation_score, 0), 6) DESC,
${MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL},
        object_id ASC
      LIMIT ?
    `
};

export function prepareRecallEventTimeWindowStatements(
  db: StorageDatabase
): RecallEventTimeWindowStatements {
  return prepareStatementGroup(db, RECALL_EVENT_TIME_WINDOW_SQL);
}
