import type { StorageDatabase } from "../../../sqlite/db.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../row-mapper.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "../statement-group-utils.js";

export interface RecallTierWindowStatements {
  readonly findRecallHotWindowStatement: SqliteStatement;
  readonly findRecallTierWindowStatement: SqliteStatement;
}

const ACTIVE_MEMORY_FILTER_SQL = `
        AND COALESCE(retention_state, '') != 'tombstoned'
        AND COALESCE(lifecycle_state, '') != 'dormant'
`;

const RECALL_TIER_WINDOW_SQL: SqlDefinitionMap<RecallTierWindowStatements> = {
  findRecallHotWindowStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = 'hot'
${ACTIVE_MEMORY_FILTER_SQL}        AND (? IS NULL OR created_at > ? OR (created_at = ? AND object_id > ?))
      ORDER BY created_at ASC, object_id ASC
      LIMIT ?
    `,
  findRecallTierWindowStatement: `
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE workspace_id = ? AND storage_tier = ?
${ACTIVE_MEMORY_FILTER_SQL}        AND (? IS NULL OR created_at > ? OR (created_at = ? AND object_id > ?))
      ORDER BY created_at ASC, object_id ASC
      LIMIT ?
    `
};

export function prepareRecallTierWindowStatements(
  db: StorageDatabase
): RecallTierWindowStatements {
  return prepareStatementGroup(db, RECALL_TIER_WINDOW_SQL);
}
