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
  mergeKeywordSearchRows,
  mergeExactKeywordSearchRows,
  normalizeKeywordSearchObjectIds,
  tokenBearsCjk,
  tokenizeFtsQuery,
  type FtsKeywordSearchRow,
  type ObjectIdFilterColumn
} from "./keyword-search.js";
import {
  MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL
} from "./semantic-tie-order.js";
import type { SqliteAllStatement } from "./statement-types.js";
import type { MemoryEntryKeywordSearchResult } from "./types.js";
import { freezeKeywordSearchResults } from "./search/freeze-keyword-results.js";
import { searchExactKeywordRows } from "./search/exact-keyword.js";
import { searchObjectKeyKeywordLanes } from "./search/object-key-fts.js";

export { searchExactKeywordRows };

export interface MemoryEntrySearchWorkflowHost {
  activeConnection(): StorageDatabase["connection"];
  readonly searchByKeywordStatement: SqliteAllStatement;
  readonly searchByKeywordPorterStatement: SqliteAllStatement;
}

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
  return searchMemoryFtsLaneRows.call(
    this, table, workspaceId, matchExpression, limit, candidateObjectIds
  );
}

export function searchMemoryFtsLaneRows(
  this: MemoryEntrySearchWorkflowHost,
  table: typeof MEMORY_FTS_TRIGRAM | typeof MEMORY_FTS_PORTER,
  workspaceId: string,
  matchExpression: string,
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
): readonly FtsKeywordSearchRow[] {
  const objectIdFilter = buildObjectIdFilterSql(
    candidateObjectIds,
    objectIdFilterColumnForFtsTable(table)
  );
  const tierPredicate = tier === undefined ? "" : "AND memory_entries.storage_tier = ?";
  return this.activeConnection().prepare(`
    SELECT ${table}.object_id, bm25(${table}) AS raw_rank
    FROM ${table}
    JOIN memory_entries ON memory_entries.object_id = ${table}.object_id
    WHERE ${table}.workspace_id = ?
      AND ${table} MATCH ?
      AND COALESCE(memory_entries.retention_state, '') != 'tombstoned'
      AND COALESCE(memory_entries.lifecycle_state, '') != 'dormant'
      ${tierPredicate}
      ${objectIdFilter.sql}
    ORDER BY raw_rank ASC, ${MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL}, ${table}.object_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    matchExpression,
    ...(tier === undefined ? [] : [tier]),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

export function objectIdFilterColumnForFtsTable(
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
  const objectKeys = searchObjectKeyKeywordLanes.call(this, {
    workspaceId: params.workspaceId,
    porterTokens: laneTokens.porter,
    trigramTokens: laneTokens.trigram,
    exactTokens: laneTokens.exact,
    limit: params.limit,
    candidateObjectIds: params.candidateObjectIds,
    tier: params.tier
  });
  return freezeKeywordSearchResults(
    mergeKeywordSearchRows(
      mergeExactKeywordSearchRows(exactRows, objectKeys.exact),
      trigramRows,
      params.limit,
      porterRows,
      { porter: objectKeys.porter, trigram: objectKeys.trigram }
    )
  );
}

export function partitionKeywordLaneTokens(tokens: readonly string[]): KeywordLaneTokens {
  const trigram = tokens.filter((token) => countQueryCodepoints(token) >= 3);
  return {
    exact: tokens.filter((token) => countQueryCodepoints(token) < 3),
    trigram,
    porter: trigram.filter((token) => !tokenBearsCjk(token))
  };
}

function searchTrigramKeywordRowsWithinObjectIds(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds: readonly string[]
): readonly FtsKeywordSearchRow[] {
  return searchMemoryFtsLaneRows.call(
    this,
    MEMORY_FTS_TRIGRAM,
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    limit,
    candidateObjectIds
  );
}

export function searchTrigramKeywordRows(
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
  return searchMemoryFtsLaneRows.call(
    this,
    MEMORY_FTS_PORTER,
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    limit,
    candidateObjectIds
  );
}

export function searchPorterKeywordRows(
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
  return searchMemoryFtsLaneRows.call(
    this,
    table,
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    limit,
    undefined,
    tier
  );
}
