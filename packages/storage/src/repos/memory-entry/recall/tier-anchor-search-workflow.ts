import type { StorageTier } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { buildAnchorScopedFtsMatch } from "../../shared/fts-lane-routing.js";
import {
  mergeKeywordSearchRows,
  type FtsKeywordSearchRow
} from "../keyword-search.js";
import type { MemoryEntrySearchWorkflowHost } from "../search-workflows.js";
import type { MemoryEntryKeywordSearchResult } from "../types.js";
import { freezeKeywordSearchResults } from "../search/freeze-keyword-results.js";

const MEMORY_FTS_TRIGRAM = "memory_content_fts";
const MEMORY_FTS_PORTER = "memory_content_fts_porter";

export async function searchByAnchorWithinTier(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[],
  limit: number,
  tier: StorageTier
): Promise<readonly MemoryEntryKeywordSearchResult[]> {
  if (!Number.isInteger(limit) || limit <= 0) return Object.freeze([]);
  const matchExpression = buildAnchorScopedFtsMatch(
    workspaceId,
    anchorTokens,
    optionalTokens
  );
  if (matchExpression === null) return Object.freeze([]);
  try {
    const trigramRows = searchAnchorFtsLaneWithinTier.call(
      this,
      MEMORY_FTS_TRIGRAM,
      workspaceId,
      matchExpression,
      limit,
      tier
    );
    const porterRows = searchAnchorFtsLaneWithinTier.call(
      this,
      MEMORY_FTS_PORTER,
      workspaceId,
      matchExpression,
      limit,
      tier
    );
    return freezeKeywordSearchResults(
      mergeKeywordSearchRows([], trigramRows, limit, porterRows)
    );
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed tier-scoped anchor search for ${workspaceId}.`,
      error
    );
  }
}

function searchAnchorFtsLaneWithinTier(
  this: MemoryEntrySearchWorkflowHost,
  table: typeof MEMORY_FTS_TRIGRAM | typeof MEMORY_FTS_PORTER,
  workspaceId: string,
  matchExpression: string,
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
  `).all(workspaceId, matchExpression, tier, limit) as readonly FtsKeywordSearchRow[];
}
