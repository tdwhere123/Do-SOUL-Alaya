import type { StorageTier } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import {
  ACTIVE_MEMORY_FILTER_SQL,
  memoryTierFilterSql
} from "../../statements/recall/active-memory-filter-sql.js";
import {
  buildObjectIdFilterSql,
  createShortKeywordMatcher,
  type ExactKeywordCandidateRow,
  type ExactKeywordSearchRow
} from "../keyword-search.js";
import { compareMemoryEntrySemanticTie } from "../../semantic-tie-order.js";

interface ExactKeywordSearchHost {
  activeConnection(): StorageDatabase["connection"];
}

const EXACT_KEYWORD_SCAN_BATCH_SIZE = 200;

type RankedExactKeywordSearchRow = ExactKeywordSearchRow & ExactKeywordCandidateRow;

export function searchExactKeywordRows(
  this: ExactKeywordSearchHost,
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
  const rows: RankedExactKeywordSearchRow[] = [];
  let lastObjectId: string | null = null;

  while (true) {
    const batch: readonly ExactKeywordCandidateRow[] = readExactKeywordCandidateBatch.call(
      this, workspaceId, objectIdFilter, lastObjectId, tier
    );
    if (batch.length === 0) break;
    rows.push(...matchExactKeywordRows(batch, tokenMatchers));
    if (batch.length < EXACT_KEYWORD_SCAN_BATCH_SIZE) break;
    lastObjectId = batch.at(-1)?.object_id ?? null;
  }

  return rows
    .sort(compareExactKeywordRows)
    .slice(0, limit)
    .map(({ object_id, matched_token_count }) => Object.freeze({
      object_id,
      matched_token_count
    }));
}

function readExactKeywordCandidateBatch(
  this: ExactKeywordSearchHost,
  workspaceId: string,
  objectIdFilter: Readonly<{ readonly sql: string; readonly params: readonly string[] }>,
  lastObjectId: string | null,
  tier?: StorageTier
): readonly ExactKeywordCandidateRow[] {
  const keysetPredicate = lastObjectId === null ? "" : "AND object_id > ?";
  const tierPredicate = memoryTierFilterSql(tier);
  return this.activeConnection().prepare(`
    SELECT
      object_id,
      content,
      dimension,
      source_kind,
      formation_kind,
      scope_class,
      event_time_start,
      event_time_end,
      valid_from,
      valid_to,
      time_precision,
      time_source,
      canonical_entities,
      facet_tags
    FROM memory_entries
    WHERE workspace_id = ?
    ${ACTIVE_MEMORY_FILTER_SQL}
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
): readonly RankedExactKeywordSearchRow[] {
  return batch.flatMap((row) => {
    const matchedTokenCount = tokenMatchers.reduce(
      (count, matcher) => count + (matcher(row.content) ? 1 : 0),
      0
    );
    return matchedTokenCount > 0
      ? [Object.freeze({ ...row, matched_token_count: matchedTokenCount })]
      : [];
  });
}

function compareExactKeywordRows(
  left: RankedExactKeywordSearchRow,
  right: RankedExactKeywordSearchRow
): number {
  return right.matched_token_count - left.matched_token_count ||
    compareMemoryEntrySemanticTie(left, right) ||
    left.object_id.localeCompare(right.object_id);
}
