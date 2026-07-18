import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  prepareStatementGroup,
  type SqlDefinitionMap,
  type SqliteStatement
} from "../statement-group-utils.js";

export interface MemoryEntrySearchStatements {
  readonly searchByKeywordStatement: SqliteStatement;
  readonly searchByKeywordPorterStatement: SqliteStatement;
}

const MEMORY_ENTRY_SEARCH_SQL: SqlDefinitionMap<MemoryEntrySearchStatements> = {
  searchByKeywordStatement: `
      SELECT
        memory_content_fts.object_id,
        bm25(memory_content_fts) AS raw_rank
      FROM memory_content_fts
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts.object_id
      WHERE
        memory_content_fts.workspace_id = ?
        AND memory_content_fts MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
      LIMIT ?
    `,
  searchByKeywordPorterStatement: `
      SELECT
        memory_content_fts_porter.object_id,
        bm25(memory_content_fts_porter) AS raw_rank
      FROM memory_content_fts_porter
      JOIN memory_entries ON memory_entries.object_id = memory_content_fts_porter.object_id
      WHERE
        memory_content_fts_porter.workspace_id = ?
        AND memory_content_fts_porter MATCH ?
        AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
        AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ORDER BY raw_rank ASC, memory_content_fts_porter.object_id ASC
      LIMIT ?
    `
};

export function prepareMemoryEntrySearchStatements(
  db: StorageDatabase
): MemoryEntrySearchStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_SEARCH_SQL);
}
