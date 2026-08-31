import type { StorageDatabase } from "../../../../sqlite/db.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../../mappers/row-mapper.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "../statement-group-utils.js";
import { MEMORY_ENTRY_ACTIVATION_ADMISSION_ORDER_SQL } from
  "../activation-admission-order.js";
import { ACTIVE_MEMORY_FILTER_SQL } from "./active-memory-filter-sql.js";

export interface RecallActivationTopKStatements {
  readonly findRecallActivationTopKStatement: SqliteStatement;
}

const RECALL_ACTIVATION_TOP_K_SQL: SqlDefinitionMap<RecallActivationTopKStatements> = {
  findRecallActivationTopKStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ?
        AND storage_tier = ?
${ACTIVE_MEMORY_FILTER_SQL}        AND (? IS NULL OR ROUND(COALESCE(activation_score, 0), 6) >= ?)
        AND object_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY ${MEMORY_ENTRY_ACTIVATION_ADMISSION_ORDER_SQL}
      LIMIT ?
    `
};

export function prepareRecallActivationTopKStatements(
  db: StorageDatabase
): RecallActivationTopKStatements {
  return prepareStatementGroup(db, RECALL_ACTIVATION_TOP_K_SQL);
}
