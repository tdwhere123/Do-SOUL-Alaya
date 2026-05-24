import type { MemoryEntryKeywordSearchResult } from "./memory-entry-repo.js";

export interface ExactKeywordCandidateRow {
  readonly object_id: string;
  readonly content: string;
}

export interface ExactKeywordSearchRow {
  readonly object_id: string;
  readonly matched_token_count: number;
}

export interface FtsKeywordSearchRow {
  readonly object_id: string;
  readonly raw_rank: number;
}

export function buildObjectIdFilterSql(
  objectIds: readonly string[] | undefined,
  columnName = "object_id"
): Readonly<{ sql: string; params: readonly string[] }> {
  if (objectIds === undefined || objectIds.length === 0) {
    return Object.freeze({
      sql: "",
      params: []
    });
  }

  return Object.freeze({
    sql: `AND ${columnName} IN (${objectIds.map(() => "?").join(", ")})`,
    params: objectIds
  });
}

export function normalizeKeywordSearchObjectIds(objectIds: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(objectIds.map((objectId) => objectId.trim()).filter((objectId) => objectId.length > 0))]
  );
}

export function mergeKeywordSearchRows(
  exactRows: readonly ExactKeywordSearchRow[],
  trigramRows: readonly FtsKeywordSearchRow[],
  limit: number,
  porterRows: readonly FtsKeywordSearchRow[] = []
): readonly Readonly<MemoryEntryKeywordSearchResult>[] {
  const exactScores = buildGroupedOrdinalScores(exactRows, (row) => row.matched_token_count);
  const trigramScores = buildGroupedOrdinalScores(trigramRows, (row) => row.raw_rank);
  const porterScores = buildGroupedOrdinalScores(porterRows, (row) => row.raw_rank);
  // Per-object trigram-lane ordinal score, kept distinct from the merged
  // normalized_rank so recall can read substring/CJK matches separately from
  // word-level porter/exact ranks. see also: recall-service trigram_fts stream.
  const trigramScoreByObjectId = new Map<string, number>();
  trigramRows.forEach((row, index) => {
    const score = trigramScores[index] ?? 0;
    trigramScoreByObjectId.set(
      row.object_id,
      Math.max(trigramScoreByObjectId.get(row.object_id) ?? 0, score)
    );
  });
  const byObjectId = new Map<
    string,
    Readonly<MemoryEntryKeywordSearchResult & { sourcePriority: number; sourceOrder: number }>
  >();

  // A lower sourcePriority wins ties: exact short-token matches (0) outrank
  // word-level porter BM25 (1), which outranks trigram substring matches (2).
  const considerRow = (
    objectId: string,
    normalizedRank: number,
    sourcePriority: number,
    sourceOrder: number
  ): void => {
    const existing = byObjectId.get(objectId);

    if (
      existing !== undefined &&
      (existing.normalized_rank > normalizedRank ||
        (existing.normalized_rank === normalizedRank && existing.sourcePriority <= sourcePriority))
    ) {
      return;
    }

    byObjectId.set(
      objectId,
      Object.freeze({
        object_id: objectId,
        normalized_rank: normalizedRank,
        sourcePriority,
        sourceOrder
      })
    );
  };

  exactRows.forEach((row, index) => {
    considerRow(row.object_id, exactScores[index] ?? 0, 0, index);
  });

  porterRows.forEach((row, index) => {
    considerRow(row.object_id, porterScores[index] ?? 0, 1, index);
  });

  trigramRows.forEach((row, index) => {
    considerRow(row.object_id, trigramScores[index] ?? 0, 2, index);
  });

  return Object.freeze(
    [...byObjectId.values()]
      .sort((left, right) => {
        const scoreDelta = right.normalized_rank - left.normalized_rank;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        const sourceDelta = left.sourcePriority - right.sourcePriority;
        if (sourceDelta !== 0) {
          return sourceDelta;
        }

        const orderDelta = left.sourceOrder - right.sourceOrder;
        if (orderDelta !== 0) {
          return orderDelta;
        }

        return left.object_id.localeCompare(right.object_id);
      })
      .slice(0, limit)
      .map((row) => {
        const trigramRank = trigramScoreByObjectId.get(row.object_id) ?? 0;
        return Object.freeze({
          object_id: row.object_id,
          normalized_rank: row.normalized_rank,
          ...(trigramRank > 0 ? { trigram_rank: trigramRank } : {})
        });
      })
  );
}

export function buildGroupedOrdinalScores<T>(
  rows: readonly T[],
  getGroupValue: (row: T) => number
): readonly number[] {
  if (rows.length === 0) {
    return [];
  }

  const scores = new Array<number>(rows.length);
  let groupStart = 0;

  while (groupStart < rows.length) {
    const groupValue = getGroupValue(rows[groupStart]!);
    let groupEnd = groupStart + 1;

    while (groupEnd < rows.length && getGroupValue(rows[groupEnd]!) === groupValue) {
      groupEnd += 1;
    }

    let total = 0;
    for (let index = groupStart; index < groupEnd; index += 1) {
      total += (rows.length - index) / rows.length;
    }

    const score = total / (groupEnd - groupStart);
    for (let index = groupStart; index < groupEnd; index += 1) {
      scores[index] = score;
    }

    groupStart = groupEnd;
  }

  return Object.freeze(scores);
}

const MAX_FTS_QUERY_TOKENS = 32;

export function tokenizeFtsQuery(queryText: string): readonly string[] {
  const tokens = Array.from(
    new Set(
      queryText
        .trim()
        .split(/\s+/u)
        .map((token) => token.replace(/\0/gu, "").replace(/[":*]/gu, "").trim())
        .filter((token) => token.length > 0)
    )
  );

  return Object.freeze(tokens.slice(0, MAX_FTS_QUERY_TOKENS));
}

export function countQueryCodepoints(value: string): number {
  return Array.from(value).length;
}

// Script routing for the dual-index FTS. The porter+unicode61 table only
// tokenizes space-delimited / Latin-script words; CJK runs collapse to a
// single token there. The trigram table is script-agnostic. A token that
// bears any CJK codepoint must be routed to the trigram table; a word-like
// Latin/Cyrillic/etc. token is additionally routed to the porter table for
// word-level stemmed BM25 while still consulting trigram for substrings.
const CJK_TOKEN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function tokenBearsCjk(token: string): boolean {
  return CJK_TOKEN_PATTERN.test(token);
}

export function createShortKeywordMatcher(token: string): (content: string) => boolean {
  if (shouldMatchShortWordByTokenBoundary(token)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(token)}($|[^\\p{L}\\p{N}_])`, "iu");
    return (content) => pattern.test(content);
  }

  const normalizedToken = token.toLocaleLowerCase();
  return (content) => content.toLocaleLowerCase().includes(normalizedToken);
}

function shouldMatchShortWordByTokenBoundary(token: string): boolean {
  return SHORT_WORD_TOKEN_PATTERN.test(token) && !SHORT_CJK_TOKEN_PATTERN.test(token);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const SHORT_CJK_TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SHORT_WORD_TOKEN_PATTERN = /^[\p{L}\p{N}_]+$/u;
