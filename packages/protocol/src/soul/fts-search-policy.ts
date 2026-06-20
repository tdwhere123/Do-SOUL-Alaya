export const TRIGRAM_MIN_CODEPOINTS = 3;
export const DEFAULT_FTS_QUERY_TOKEN_LIMIT = 16;
export const DEFAULT_FTS_QUERY_MIN_TOKEN_LENGTH = 2;

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

export interface FtsLaneRankRow {
  readonly object_id: string;
  readonly raw_rank: number;
}

export interface FtsQueryTokenizerOptions {
  readonly minTokenLength?: number;
  readonly maxTokens?: number;
  readonly shouldSegmentToken?: (token: string) => boolean;
  readonly segmentToken?: (token: string) => readonly string[];
}

export function splitFtsLanes(tokens: readonly string[]): FtsLaneSplit {
  const porterTokens: string[] = [];
  const trigramTokens: string[] = [];
  for (const token of tokens) {
    if (CJK_SCRIPT_PATTERN.test(token)) {
      if (Array.from(token).length >= TRIGRAM_MIN_CODEPOINTS) {
        trigramTokens.push(token);
      } else {
        porterTokens.push(token);
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

export function tokenizeFtsQuery(
  queryText: string,
  options: FtsQueryTokenizerOptions = {}
): readonly string[] {
  const minTokenLength = options.minTokenLength ?? DEFAULT_FTS_QUERY_MIN_TOKEN_LENGTH;
  const maxTokens = options.maxTokens ?? DEFAULT_FTS_QUERY_TOKEN_LIMIT;
  const surfaceTokens = queryText
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length >= minTokenLength);
  const expanded: string[] = [];
  for (const token of surfaceTokens) {
    expanded.push(token);
    if (options.shouldSegmentToken?.(token) === true && options.segmentToken !== undefined) {
      for (const piece of options.segmentToken(token)) {
        const trimmed = piece.trim();
        if (trimmed.length >= minTokenLength && trimmed !== token) {
          expanded.push(trimmed);
        }
      }
    }
  }
  return Object.freeze(Array.from(new Set(expanded)).slice(0, maxTokens));
}

export function rankFtsLaneRows(rows: readonly FtsLaneRankRow[]): readonly FtsLaneHit[] {
  if (rows.length === 0) {
    return Object.freeze([]);
  }
  const scores = buildGroupedOrdinalScores(rows, (row) => row.raw_rank);
  return Object.freeze(
    rows.map((row, index) =>
      Object.freeze({
        object_id: row.object_id,
        normalized_rank: scores[index] ?? 0
      })
    )
  );
}

export function mergeFtsLanes(
  porterHits: readonly FtsLaneHit[],
  trigramHits: readonly FtsLaneHit[],
  limit: number
): readonly FtsLaneHit[] {
  const merged = new Map<
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  >();
  porterHits.forEach((hit, index) => considerLaneHit(merged, hit, 0, index));
  trigramHits.forEach((hit, index) => considerLaneHit(merged, hit, 1, index));
  if (merged.size === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(buildMergedLaneHits(merged, limit));
}

function considerLaneHit(
  merged: Map<
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  >,
  hit: FtsLaneHit,
  lanePriority: number,
  laneOrder: number
): void {
  const existing = merged.get(hit.object_id);
  if (shouldKeepExistingLaneHit(existing, hit, lanePriority)) {
    return;
  }
  merged.set(
    hit.object_id,
    Object.freeze({ normalizedRank: hit.normalized_rank, lanePriority, laneOrder })
  );
}

function shouldKeepExistingLaneHit(
  existing:
    | Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
    | undefined,
  hit: FtsLaneHit,
  lanePriority: number
): boolean {
  return (
    existing !== undefined &&
    (existing.normalizedRank > hit.normalized_rank ||
      (existing.normalizedRank === hit.normalized_rank &&
        existing.lanePriority <= lanePriority))
  );
}

function buildMergedLaneHits(
  merged: ReadonlyMap<
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  >,
  limit: number
): readonly FtsLaneHit[] {
  return [...merged.entries()]
    .sort(compareMergedLaneHits)
    .slice(0, limit)
    .map(([objectId, entry]) =>
      Object.freeze({ object_id: objectId, normalized_rank: entry.normalizedRank })
    );
}

function compareMergedLaneHits(
  left: readonly [
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  ],
  right: readonly [
    string,
    Readonly<{ normalizedRank: number; lanePriority: number; laneOrder: number }>
  ]
): number {
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
}

export function buildGroupedOrdinalScores<T>(
  rows: readonly T[],
  getGroupValue: (row: T) => number
): readonly number[] {
  if (rows.length === 0) {
    return Object.freeze([]);
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
