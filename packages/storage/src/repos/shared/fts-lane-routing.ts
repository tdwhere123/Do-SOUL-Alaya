import {
  tokenizeFtsQuery as tokenizeFtsQueryPolicy,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import {
  isCjkSegmentationCandidate,
  segmentCjkRun
} from "./cjk-segmentation.js";
import { parseRows } from "./parse-row.js";
import { FtsLaneRankRowParser } from "./sqlite-row-schemas.js";

export {
  CJK_SCRIPT_PATTERN,
  mergeFtsLanes,
  splitFtsLanes,
  TRIGRAM_MIN_CODEPOINTS,
  type FtsLaneSplit
} from "@do-soul/alaya-protocol";

export function buildFtsMatchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

export function buildWorkspaceScopedFtsMatch(
  workspaceId: string,
  tokens: readonly string[]
): string {
  return `workspace_id:"${workspaceId.replace(/"/g, '""')}" AND content:(${buildFtsMatchExpression(tokens)})`;
}

// Require ≥1 anchor token, but keep all terms in the MATCH so BM25 still ranks
// by them; null when no anchor so the caller falls back to the relaxed OR lane.
export function buildAnchorScopedFtsMatch(
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[]
): string | null {
  const anchors = dedupeNonEmpty(anchorTokens);
  if (anchors.length === 0) {
    return null;
  }
  const allTerms = dedupeNonEmpty([...anchorTokens, ...optionalTokens]);
  const required = `(${buildFtsMatchExpression(anchors)})`;
  const body =
    allTerms.length === anchors.length
      ? required
      : `${required} AND (${buildFtsMatchExpression(allTerms)})`;
  return `workspace_id:"${workspaceId.replace(/"/g, '""')}" AND content:(${body})`;
}

function dedupeNonEmpty(tokens: readonly string[]): readonly string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))];
}

export function queryFtsLaneRows(
  statement: { all(...params: unknown[]): unknown },
  workspaceId: string,
  laneTokens: readonly string[],
  limit: number
): readonly FtsLaneRankRow[] {
  const matchExpression = buildWorkspaceScopedFtsMatch(workspaceId, laneTokens);
  return Object.freeze(parseRows(
    statement.all(workspaceId, matchExpression, limit),
    FtsLaneRankRowParser,
    "fts lane rank row"
  ));
}

export function tokenizeFtsQuery(queryText: string): readonly string[] {
  return tokenizeFtsQueryPolicy(queryText, {
    shouldSegmentToken: isCjkSegmentationCandidate,
    segmentToken: segmentCjkRun
  });
}
