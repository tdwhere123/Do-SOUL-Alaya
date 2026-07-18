import { StorageError } from "../../shared/errors.js";
import type { StorageTier } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  buildAnchorScopedFtsMatch,
  buildWorkspaceScopedFtsMatch
} from "../shared/fts-lane-routing.js";
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
  type FtsKeywordSearchRow,
  type ObjectIdFilterColumn
} from "./keyword-search.js";
import type { SqliteAllStatement } from "./statement-types.js";
import type { MemoryEntryKeywordSearchResult } from "./types.js";
import { freezeKeywordSearchResults } from "./search/freeze-keyword-results.js";

export interface MemoryEntrySearchWorkflowHost {
  readonly db: StorageDatabase;
  readonly searchByKeywordStatement: SqliteAllStatement;
  readonly searchByKeywordPorterStatement: SqliteAllStatement;
}
const EXACT_KEYWORD_SCAN_BATCH_SIZE = 200;

interface KeywordLaneTokens {
  readonly exact: readonly string[];
  readonly trigram: readonly string[];
  readonly porter: readonly string[];
}
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

export async function searchByKeywordWithinTier(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  queryText: string,
  limit: number,
  tier: StorageTier
): Promise<readonly MemoryEntryKeywordSearchResult[]> {
  try {
    return searchKeywordRows.call(this, { workspaceId, queryText, limit, tier });
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to search ${tier} memory entries for workspace ${workspaceId}.`,
      error
    );
  }
}

const MEMORY_FTS_TRIGRAM = "memory_content_fts";
const MEMORY_FTS_PORTER = "memory_content_fts_porter";
// Runs the anchor MATCH against both the porter and trigram tables and merges;
// [] when there is no anchor so the caller keeps only the relaxed lane.
export async function searchByAnchorWithinObjectIds(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[],
  limit: number,
  objectIds: readonly string[]
): Promise<readonly MemoryEntryKeywordSearchResult[]> {
  const candidateObjectIds = normalizeKeywordSearchObjectIds(objectIds);
  if (candidateObjectIds.length === 0 || !Number.isInteger(limit) || limit <= 0) {
    return Object.freeze([]);
  }
  const matchExpression = buildAnchorScopedFtsMatch(workspaceId, anchorTokens, optionalTokens);
  if (matchExpression === null) {
    return Object.freeze([]);
  }
  try {
    const trigramRows = searchAnchorFtsLane.call(
      this, MEMORY_FTS_TRIGRAM, workspaceId, matchExpression, limit, candidateObjectIds
    );
    const porterRows = searchAnchorFtsLane.call(
      this, MEMORY_FTS_PORTER, workspaceId, matchExpression, limit, candidateObjectIds
    );
    return freezeKeywordSearchResults(
      mergeKeywordSearchRows([], trigramRows, limit, porterRows)
    );
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed anchor search for workspace ${workspaceId}.`,
      error
    );
  }
}

function searchAnchorFtsLane(
  this: MemoryEntrySearchWorkflowHost,
  table: typeof MEMORY_FTS_TRIGRAM | typeof MEMORY_FTS_PORTER,
  workspaceId: string,
  matchExpression: string,
  limit: number,
  candidateObjectIds: readonly string[]
): readonly FtsKeywordSearchRow[] {
  const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds, objectIdFilterColumnForFtsTable(table));
  return this.db.connection.prepare(`
    SELECT
      ${table}.object_id,
      bm25(${table}) AS raw_rank
    FROM ${table}
    JOIN memory_entries ON memory_entries.object_id = ${table}.object_id
    WHERE
      ${table}.workspace_id = ?
      AND ${table} MATCH ?
      AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
    ${objectIdFilter.sql}
    ORDER BY raw_rank ASC, ${table}.object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    matchExpression,
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function objectIdFilterColumnForFtsTable(
  table: typeof MEMORY_FTS_TRIGRAM | typeof MEMORY_FTS_PORTER
): ObjectIdFilterColumn {
  return table === MEMORY_FTS_TRIGRAM
    ? "memory_content_fts.object_id"
    : "memory_content_fts_porter.object_id";
}

function searchKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  params: Readonly<{
    readonly workspaceId: string;
    readonly queryText: string;
    readonly limit: number;
    readonly candidateObjectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>): readonly MemoryEntryKeywordSearchResult[] {
  const tokens = tokenizeFtsQuery(params.queryText);

  if (tokens.length === 0 || !Number.isInteger(params.limit) || params.limit <= 0) {
    return Object.freeze([]);
  }

  const laneTokens = partitionKeywordLaneTokens(tokens);
  const exactRows = searchExactKeywordRows.call(
    this,
    params.workspaceId,
    laneTokens.exact,
    params.limit,
    params.candidateObjectIds,
    params.tier
  );
  const trigramRows = searchTrigramKeywordRows.call(
    this,
    params.workspaceId,
    laneTokens.trigram,
    params.limit,
    params.candidateObjectIds,
    params.tier
  );
  const porterRows = searchPorterKeywordRows.call(
    this,
    params.workspaceId,
    laneTokens.porter,
    params.limit,
    params.candidateObjectIds,
    params.tier
  );
  return freezeKeywordSearchResults(
    mergeKeywordSearchRows(exactRows, trigramRows, params.limit, porterRows)
  );
}

function partitionKeywordLaneTokens(tokens: readonly string[]): KeywordLaneTokens {
  const trigram = tokens.filter((token) => countQueryCodepoints(token) >= 3);
  return {
    exact: tokens.filter((token) => countQueryCodepoints(token) < 3),
    trigram,
    porter: trigram.filter((token) => !tokenBearsCjk(token))
  };
}

function searchExactKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
): readonly ExactKeywordSearchRow[] {
  if (tokens.length === 0) {
    return [];
  }

  const tokenMatchers = tokens.map((token) => createShortKeywordMatcher(token));
  const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds);
  const rows: ExactKeywordSearchRow[] = [];
  let lastObjectId: string | null = null;

  while (true) {
    const batch: readonly ExactKeywordCandidateRow[] = readExactKeywordCandidateBatch.call(
      this,
      workspaceId,
      objectIdFilter,
      lastObjectId,
      tier
    );

    if (batch.length === 0) {
      break;
    }

    rows.push(...matchExactKeywordRows(batch, tokenMatchers));

    if (batch.length < EXACT_KEYWORD_SCAN_BATCH_SIZE) {
      break;
    }
    lastObjectId = batch.at(-1)?.object_id ?? null;
  }

  return rows
    .sort(compareExactKeywordRows)
    .slice(0, limit);
}

function readExactKeywordCandidateBatch(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  objectIdFilter: Readonly<{ readonly sql: string; readonly params: readonly string[] }>,
  lastObjectId: string | null,
  tier?: StorageTier
): readonly ExactKeywordCandidateRow[] {
  const keysetPredicate = lastObjectId === null ? "" : "AND object_id > ?";
  const tierPredicate = tier === undefined ? "" : "AND storage_tier = ?";
  return this.db.connection.prepare(`
    SELECT object_id, content
    FROM memory_entries
    WHERE workspace_id = ?
    AND COALESCE(retention_state, '') != 'tombstoned'
    AND COALESCE(lifecycle_state, '') != 'dormant'
    ${objectIdFilter.sql}
    ${tierPredicate}
    ${keysetPredicate}
    ORDER BY object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    ...objectIdFilter.params,
    ...(tier === undefined ? [] : [tier]),
    ...(lastObjectId === null ? [] : [lastObjectId]),
    EXACT_KEYWORD_SCAN_BATCH_SIZE
  ) as readonly ExactKeywordCandidateRow[];
}

function matchExactKeywordRows(
  batch: readonly ExactKeywordCandidateRow[],
  tokenMatchers: readonly ((content: string) => boolean)[]
): readonly ExactKeywordSearchRow[] {
  return batch.flatMap((row) => {
    const matchedTokenCount = tokenMatchers.reduce(
      (count, matcher) => count + (matcher(row.content) ? 1 : 0),
      0
    );
    return matchedTokenCount > 0
      ? [Object.freeze({ object_id: row.object_id, matched_token_count: matchedTokenCount })]
      : [];
  });
}

function compareExactKeywordRows(
  left: ExactKeywordSearchRow,
  right: ExactKeywordSearchRow
): number {
  return right.matched_token_count - left.matched_token_count || left.object_id.localeCompare(right.object_id);
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
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchTrigramKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
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
  if (tier !== undefined) {
    return searchFtsKeywordRowsWithinTier.call(
      this, MEMORY_FTS_TRIGRAM, workspaceId, tokens, limit, tier
    );
  }

  return this.searchByKeywordStatement.all(
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
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
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchPorterKeywordRows(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
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
  if (tier !== undefined) {
    return searchFtsKeywordRowsWithinTier.call(
      this, MEMORY_FTS_PORTER, workspaceId, tokens, limit, tier
    );
  }

  return this.searchByKeywordPorterStatement.all(
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    limit
  ) as readonly FtsKeywordSearchRow[];
}

function searchFtsKeywordRowsWithinTier(
  this: MemoryEntrySearchWorkflowHost,
  table: typeof MEMORY_FTS_TRIGRAM | typeof MEMORY_FTS_PORTER,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  tier: StorageTier
): readonly FtsKeywordSearchRow[] {
  return this.db.connection.prepare(`
    SELECT ${table}.object_id, bm25(${table}) AS raw_rank
    FROM ${table}
    JOIN memory_entries ON memory_entries.object_id = ${table}.object_id
    WHERE ${table}.workspace_id = ? AND ${table} MATCH ?
      AND memory_entries.storage_tier = ?
      AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
    ORDER BY raw_rank ASC, ${table}.object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    tier,
    limit
  ) as readonly FtsKeywordSearchRow[];
}
