import type BetterSqlite3 from "better-sqlite3";
import {
  rankFtsLaneRows,
  tokenizeFtsQuery as tokenizeFtsQueryPolicy,
  type FtsLaneHit,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import {
  isCjkSegmentationCandidate,
  segmentCjkRun
} from "./cjk-segmentation.js";

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

export function queryFtsLane(
  statement: BetterSqlite3.Statement,
  workspaceId: string,
  laneTokens: readonly string[],
  limit: number
): readonly FtsLaneHit[] {
  const matchExpression = buildWorkspaceScopedFtsMatch(workspaceId, laneTokens);
  const rows = statement.all(workspaceId, matchExpression, limit) as readonly FtsLaneRankRow[];
  return rankFtsLaneRows(rows);
}

export function tokenizeFtsQuery(queryText: string): readonly string[] {
  return tokenizeFtsQueryPolicy(queryText, {
    shouldSegmentToken: isCjkSegmentationCandidate,
    segmentToken: segmentCjkRun
  });
}
