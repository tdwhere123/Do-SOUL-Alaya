import type { StorageTier } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { buildWorkspaceScopedFtsMatch } from "../../../shared/fts-lane-routing.js";
import {
  ACTIVE_MEMORY_ENTRIES_FILTER_SQL,
  memoryTierFilterSql
} from "../../statements/recall/active-memory-filter-sql.js";
import {
  buildObjectIdFilterSql,
  createShortKeywordMatcher,
  objectKeyExactTokens,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow,
  type ObjectIdFilterColumn
} from "../keyword-search.js";

interface ObjectKeySearchHost {
  activeConnection(): StorageDatabase["connection"];
}

interface ObjectKeyKeywordLanes {
  readonly porter: readonly FtsKeywordSearchRow[];
  readonly trigram: readonly FtsKeywordSearchRow[];
  readonly exact: readonly ExactKeywordSearchRow[];
}

const KEY_FTS_PORTER = "memory_object_key_fts";
const KEY_FTS_TRIGRAM = "memory_object_key_fts_trigram";
const EXACT_KEY_SCAN_BATCH_SIZE = 200;

interface ObjectKeySurfaceRow {
  readonly owner_id: string;
  readonly key_id: string;
  readonly surface: string;
}

interface ExactKeyScanCursor {
  readonly ownerId: string;
  readonly keyId: string;
}

export function searchObjectKeyKeywordLanes(
  this: ObjectKeySearchHost,
  params: Readonly<{
    readonly workspaceId: string;
    readonly porterTokens: readonly string[];
    readonly trigramTokens: readonly string[];
    readonly exactTokens: readonly string[];
    readonly limit: number;
    readonly candidateObjectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>
): Readonly<ObjectKeyKeywordLanes> {
  return Object.freeze({
    porter: searchObjectKeyFtsLane.call(
      this, KEY_FTS_PORTER, params.workspaceId, params.porterTokens, params.limit,
      params.candidateObjectIds, params.tier
    ),
    trigram: searchObjectKeyFtsLane.call(
      this, KEY_FTS_TRIGRAM, params.workspaceId, params.trigramTokens, params.limit,
      params.candidateObjectIds, params.tier
    ),
    exact: searchExactObjectKeyRows.call(
      this, params.workspaceId, params.exactTokens, params.limit,
      params.candidateObjectIds, params.tier
    )
  });
}

function searchObjectKeyFtsLane(
  this: ObjectKeySearchHost,
  table: typeof KEY_FTS_PORTER | typeof KEY_FTS_TRIGRAM,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
): readonly FtsKeywordSearchRow[] {
  if (tokens.length === 0) return [];
  const objectIdFilter = buildObjectIdFilterSql(
    candidateObjectIds,
    objectIdFilterColumnForKeyTable(table)
  );
  const tierPredicate = memoryTierFilterSql(tier, "memory_entries.storage_tier");
  return this.activeConnection().prepare(`
    SELECT ${table}.owner_id AS object_id, bm25(${table}) AS raw_rank
    FROM ${table}
    JOIN memory_entries ON memory_entries.object_id = ${table}.owner_id
    WHERE ${table}.workspace_id = ?
      AND ${table} MATCH ?
      ${ACTIVE_MEMORY_ENTRIES_FILTER_SQL}
      ${tierPredicate}
      ${objectIdFilter.sql}
    ORDER BY raw_rank ASC, ${table}.owner_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    buildWorkspaceScopedFtsMatch(workspaceId, tokens),
    ...(tier === undefined ? [] : [tier]),
    ...objectIdFilter.params,
    limit
  ) as readonly FtsKeywordSearchRow[];
}

export function objectIdFilterColumnForKeyTable(
  table: typeof KEY_FTS_PORTER | typeof KEY_FTS_TRIGRAM
): ObjectIdFilterColumn {
  return table === KEY_FTS_TRIGRAM
    ? "memory_object_key_fts_trigram.owner_id"
    : "memory_object_key_fts.owner_id";
}

function searchExactObjectKeyRows(
  this: ObjectKeySearchHost,
  workspaceId: string,
  tokens: readonly string[],
  limit: number,
  candidateObjectIds?: readonly string[],
  tier?: StorageTier
): readonly ExactKeywordSearchRow[] {
  const exactTokens = objectKeyExactTokens(tokens);
  if (exactTokens.length === 0) return [];
  const tokenMatchers = exactTokens.map((token) => createShortKeywordMatcher(token));
  const counts = new Map<string, number>();
  let cursor: ExactKeyScanCursor | null = null;
  while (true) {
    const batch: readonly ObjectKeySurfaceRow[] = readExactObjectKeyBatch.call(
      this, workspaceId, candidateObjectIds, cursor, tier
    );
    if (batch.length === 0) break;
    for (const row of batch) {
      const matched = tokenMatchers.reduce(
        (count, matcher) => count + (matcher(row.surface) ? 1 : 0),
        0
      );
      if (matched > 0) {
        counts.set(row.owner_id, Math.max(counts.get(row.owner_id) ?? 0, matched));
      }
    }
    if (batch.length < EXACT_KEY_SCAN_BATCH_SIZE) break;
    const last = batch.at(-1);
    cursor = last === undefined ? null : { ownerId: last.owner_id, keyId: last.key_id };
  }
  return Object.freeze(
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([object_id, matched_token_count]) => Object.freeze({ object_id, matched_token_count }))
  );
}

function readExactObjectKeyBatch(
  this: ObjectKeySearchHost,
  workspaceId: string,
  candidateObjectIds: readonly string[] | undefined,
  cursor: ExactKeyScanCursor | null,
  tier?: StorageTier
): readonly ObjectKeySurfaceRow[] {
  const objectIdFilter = buildObjectIdFilterSql(candidateObjectIds, "k.owner_id");
  // Owner-only keyset skips the remaining keys of the last owner in a full batch.
  const keysetPredicate = cursor === null
    ? ""
    : "AND (k.owner_id > ? OR (k.owner_id = ? AND k.key_id > ?))";
  const tierPredicate = memoryTierFilterSql(tier, "memory_entries.storage_tier");
  return this.activeConnection().prepare(`
    SELECT k.owner_id, k.key_id, k.surface
    FROM memory_object_keys k
    JOIN memory_entries ON memory_entries.object_id = k.owner_id
    WHERE k.workspace_id = ?
      ${ACTIVE_MEMORY_ENTRIES_FILTER_SQL}
      ${objectIdFilter.sql}
      ${tierPredicate}
      ${keysetPredicate}
    ORDER BY k.owner_id ASC, k.key_id ASC
    LIMIT ?
  `).all(
    workspaceId,
    ...objectIdFilter.params,
    ...(tier === undefined ? [] : [tier]),
    ...(cursor === null ? [] : [cursor.ownerId, cursor.ownerId, cursor.keyId]),
    EXACT_KEY_SCAN_BATCH_SIZE
  ) as readonly ObjectKeySurfaceRow[];
}
