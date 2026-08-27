import type { StorageDatabase } from "../../../sqlite/db.js";
import { MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL } from "../semantic-tie-order.js";
import { ACTIVE_MEMORY_ENTRIES_FILTER_SQL } from "../recall/active-memory-filter-sql.js";
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
        ${ACTIVE_MEMORY_ENTRIES_FILTER_SQL}
      ORDER BY raw_rank ASC, ${MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL}, memory_content_fts.object_id ASC
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
        ${ACTIVE_MEMORY_ENTRIES_FILTER_SQL}
      ORDER BY raw_rank ASC, ${MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL}, memory_content_fts_porter.object_id ASC
      LIMIT ?
    `
};

export function prepareMemoryEntrySearchStatements(
  db: StorageDatabase
): MemoryEntrySearchStatements {
  return prepareStatementGroup(db, MEMORY_ENTRY_SEARCH_SQL);
}
