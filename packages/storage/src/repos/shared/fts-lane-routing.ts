import type BetterSqlite3 from "better-sqlite3";
import { buildGroupedOrdinalScores } from "../memory-entry-keyword-search.js";

// Trigram FTS5 tables only index runs of >= 3 codepoints; shorter terms can
// never match and must not be sent to the trigram lane.
export const TRIGRAM_MIN_CODEPOINTS = 3;

// A token routed to the trigram lane if it carries any CJK-family character;
// unicode61 collapses such a run into one token and is effectively blind to it.
export const CJK_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface FtsLaneSplit {
  readonly porterTokens: readonly string[];
  readonly trigramTokens: readonly string[];
}

export interface FtsLaneHit {
  readonly object_id: string;
  readonly normalized_rank: number;
}

/**
 * Route FTS query tokens by character script. CJK-bearing tokens go to the
 * trigram lane (substring-capable); plain word tokens go to the porter
 * unicode61 lane (English BM25 + stemming). A mixed-script query fans out to
 * both lanes. Shared by the evidence_capsule and synthesis_capsule dual-index
 * repos so the lane-routing rule lives in exactly one place.
 */
export function splitFtsLanes(tokens: readonly string[]): FtsLaneSplit {
  const porterTokens: string[] = [];
  const trigramTokens: string[] = [];
  for (const token of tokens) {
    if (CJK_SCRIPT_PATTERN.test(token)) {
      if (Array.from(token).length >= TRIGRAM_MIN_CODEPOINTS) {
        trigramTokens.push(token);
      }
    } else {
      porterTokens.push(token);
    }
  }
  return Object.freeze({
    porterTokens: Object.freeze(porterTokens),
    trigramTokens: Object.freeze(trigramTokens)
  });
}

export function buildFtsMatchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Run one FTS lane statement and score its rows by ordinal rank.
 *
 * Rows arrive ordered by raw bm25 (best first). Score by ordinal rank, not
 * raw bm25 magnitude: an affine min-max would pin a lane's own best hit to
 * 1.0 regardless of absolute match quality, so a weak hit in a narrow-span
 * lane could outrank a strong hit in a wide-span lane after merge. Ordinal
 * scores share one comparable scale across the porter and trigram lanes.
 *
 * The lane statement must accept `(workspaceId, matchExpression, limit)` and
 * return rows shaped `{ object_id, raw_rank }`.
 */
export function queryFtsLane(
  statement: BetterSqlite3.Statement,
  workspaceId: string,
  laneTokens: readonly string[],
  limit: number
): readonly FtsLaneHit[] {
  const matchExpression = buildFtsMatchExpression(laneTokens);
  const rows = statement.all(workspaceId, matchExpression, limit) as ReadonlyArray<{
    readonly object_id: string;
    readonly raw_rank: number;
  }>;
  if (rows.length === 0) {
    return [];
  }
  const scores = buildGroupedOrdinalScores(rows, (row) => row.raw_rank);
  return rows.map((row, index) =>
    Object.freeze({
      object_id: row.object_id,
      normalized_rank: scores[index] ?? 0
    })
  );
}

/**
 * Cross-lane fusion: each lane is scored by ordinal rank (position-only,
 * BM25-magnitude-independent) so the porter and trigram lanes share one
 * comparable scale. A lane-priority tiebreak (porter 0 outranks trigram 1)
 * makes an exact score tie deterministic toward the higher-trust word lane
 * rather than an arbitrary id sort.
 */
export function mergeFtsLanes(
  porterHits: readonly FtsLaneHit[],
  trigramHits: readonly FtsLaneHit[],
  limit: number
): readonly FtsLaneHit[] {
  const merged = new Map<
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  >();
  const considerLaneHit = (
    hit: FtsLaneHit,
    lanePriority: number,
    laneOrder: number
  ): void => {
    const existing = merged.get(hit.object_id);
    if (
      existing !== undefined &&
      (existing.normalizedRank > hit.normalized_rank ||
        (existing.normalizedRank === hit.normalized_rank &&
          existing.lanePriority <= lanePriority))
    ) {
      return;
    }
    merged.set(
      hit.object_id,
      Object.freeze({ normalizedRank: hit.normalized_rank, lanePriority, laneOrder })
    );
  };
  porterHits.forEach((hit, index) => considerLaneHit(hit, 0, index));
  trigramHits.forEach((hit, index) => considerLaneHit(hit, 1, index));
  if (merged.size === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    [...merged.entries()]
      .sort((left, right) => {
        const rankDelta = right[1].normalizedRank - left[1].normalizedRank;
        if (rankDelta !== 0) {
          return rankDelta;
        }
        const priorityDelta = left[1].lanePriority - right[1].lanePriority;
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        const orderDelta = left[1].laneOrder - right[1].laneOrder;
        if (orderDelta !== 0) {
          return orderDelta;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, limit)
      .map(([objectId, entry]) =>
        Object.freeze({ object_id: objectId, normalized_rank: entry.normalizedRank })
      )
  );
}

/**
 * Tokenize an FTS query string into the dual-lane token set. NFKC-normalized,
 * split on non-word characters, terms shorter than 2 chars dropped, capped at
 * 16 tokens. Shared so the evidence and synthesis repos tokenize identically.
 */
export function tokenizeFtsQuery(queryText: string): readonly string[] {
  return queryText
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= 2)
    .slice(0, 16);
}
