import { StorageError } from "../../shared/errors.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  buildObjectIdFilterSql,
  countQueryCodepoints,
  createShortKeywordMatcher,
  mergeKeywordSearchRows,
  normalizeKeywordSearchObjectIds,
  tokenBearsCjk,
  tokenizeFtsQuery,
  type ExactKeywordCandidateRow,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "./keyword-search.js";
import type { SqliteAllStatement } from "./statement-types.js";
import type { MemoryEntryKeywordSearchResult } from "./types.js";

export interface MemoryEntrySearchWorkflowHost {
  readonly db: StorageDatabase;
  readonly searchByKeywordStatement: SqliteAllStatement;
  readonly searchByKeywordPorterStatement: SqliteAllStatement;
}

const EXACT_KEYWORD_SCAN_BATCH_SIZE = 200;

export async function searchByKeyword(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  queryText: string,
  limit: number
): Promise<readonly MemoryEntryKeywordSearchResult[]> {
  try {
    return searchKeywordRows.call(this, { workspaceId, queryText, limit });
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to search memory entries for workspace ${workspaceId}.`,
      error
    );
  }
}

export async function searchByKeywordWithinObjectIds(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  queryText: string,
  limit: number,
  objectIds: readonly string[]
): Promise<readonly MemoryEntryKeywordSearchResult[]> {
  const candidateObjectIds = normalizeKeywordSearchObjectIds(objectIds);

  if (candidateObjectIds.length === 0) {
    return Object.freeze([]);
  }

  try {
    return searchKeywordRows.call(this, {
      workspaceId,
      queryText,
      limit,
      candidateObjectIds
    });
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to search filtered memory entries for workspace ${workspaceId}.`,
      error
    );
  }
}

function searchKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  params: Readonly<{
    readonly workspaceId: string;
    readonly queryText: string;
    readonly limit: number;
    readonly candidateObjectIds?: readonly string[];
  }>): readonly MemoryEntryKeywordSearchResult[] {
  const tokens = tokenizeFtsQuery(params.queryText);

  if (tokens.length === 0 || !Number.isInteger(params.limit) || params.limit <= 0) {
    return Object.freeze([]);
  }

  const shortTokens = tokens.filter((token) => countQueryCodepoints(token) < 3);
  const trigramTokens = tokens.filter((token) => countQueryCodepoints(token) >= 3);
  // invariant: long Latin tokens hit both trigram substrings and porter word BM25.
  const porterTokens = trigramTokens.filter((token) => !tokenBearsCjk(token));
  const exactRows = searchExactKeywordRows.call(
    this,
    params.workspaceId,
    shortTokens,
    params.limit,
    params.candidateObjectIds
  );
  const trigramRows = searchTrigramKeywordRows.call(
    this,
    params.workspaceId,
    trigramTokens,
    params.limit,
    params.candidateObjectIds
  );
  const porterRows = searchPorterKeywordRows.call(
    this,
    params.workspaceId,
    porterTokens,
    params.limit,
    params.candidateObjectIds
  );
  const mergedRows = mergeKeywordSearchRows(
    exactRows,
    trigramRows,
    params.limit,
    porterRows
  );

  return Object.freeze(
    mergedRows.map((row) =>
      Object.freeze({
        object_id: row.object_id,
        normalized_rank: row.normalized_rank,
        ...(row.trigram_rank !== undefined ? { trigram_rank: row.trigram_rank } : {})
      })
    )
  );
}

function searchExactKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[]
): readonly ExactKeywordSearchRow[] {
  if (tokens.length === 0) {
    return [];
  }

  const tokenMatchers = tokens.map((token) => createShortKeywordMatcher(token));
  const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds);
  const rows: ExactKeywordSearchRow[] = [];
  let lastObjectId: string | null = null;

  while (true) {
    const keysetPredicate = lastObjectId === null ? "" : "AND object_id > ?";
    const batch = this.db.connection.prepare(`
      SELECT
        object_id,
        content
      FROM memory_entries
      WHERE workspace_id = ?
      AND COALESCE(retention_state, '') != 'tombstoned'
      AND COALESCE(lifecycle_state, '') != 'dormant'
      ${objectIdFilter.sql}
      ${keysetPredicate}
      ORDER BY object_id ASC
      LIMIT ?
    `).all(
      workspaceId,
      ...objectIdFilter.params,
      ...(lastObjectId === null ? [] : [lastObjectId]),
      EXACT_KEYWORD_SCAN_BATCH_SIZE
    ) as readonly ExactKeywordCandidateRow[];

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      const matchedTokenCount = tokenMatchers.reduce(
        (count, matcher) => count + (matcher(row.content) ? 1 : 0),
        0
      );
      if (matchedTokenCount > 0) {
        rows.push(
          Object.freeze({
            object_id: row.object_id,
            matched_token_count: matchedTokenCount
          })
        );
      }
    }

    if (batch.length < EXACT_KEYWORD_SCAN_BATCH_SIZE) {
      break;
    }
    lastObjectId = batch.at(-1)?.object_id ?? null;
  }

  return rows
    .sort((left, right) => {
      const matchDelta = right.matched_token_count - left.matched_token_count;
      if (matchDelta !== 0) {
        return matchDelta;
      }

      return left.object_id.localeCompare(right.object_id);
    })
    .slice(0, limit);
}

function searchTrigramKeywordRowsWithinObjectIds(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds: readonly string[]
): readonly FtsKeywordSearchRow[] {
  const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds, "memory_content_fts.object_id");

  return this.db.connection.prepare(`
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
    ${objectIdFilter.sql}
    ORDER BY raw_rank ASC, memory_content_fts.object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    tokens.map((token) => `"${token}"`).join(" OR "),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchTrigramKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[]
): readonly FtsKeywordSearchRow[] {
  if (tokens.length === 0) {
    return [];
  }

  if (candidateObjectIds !== undefined) {
    return searchTrigramKeywordRowsWithinObjectIds.call(
      this,
      workspaceId,
      tokens,
      limit,
      candidateObjectIds
    );
  }

  return this.searchByKeywordStatement.all(
    workspaceId,
    tokens.map((token) => `"${token}"`).join(" OR "),
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchPorterKeywordRowsWithinObjectIds(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds: readonly string[]
): readonly FtsKeywordSearchRow[] {
  const objectIdFilter = buildObjectIdFilterSql(
    candidateObjectIds,
    "memory_content_fts_porter.object_id"
  );

  return this.db.connection.prepare(`
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
    ${objectIdFilter.sql}
    ORDER BY raw_rank ASC, memory_content_fts_porter.object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    tokens.map((token) => `"${token}"`).join(" OR "),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchPorterKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[]
): readonly FtsKeywordSearchRow[] {
  if (tokens.length === 0) {
    return [];
  }

  if (candidateObjectIds !== undefined) {
    return searchPorterKeywordRowsWithinObjectIds.call(
      this,
      workspaceId,
      tokens,
      limit,
      candidateObjectIds
    );
  }

  return this.searchByKeywordPorterStatement.all(
    workspaceId,
    tokens.map((token) => `"${token}"`).join(" OR "),
    limit
  ) as readonly FtsKeywordSearchRow[];
}
