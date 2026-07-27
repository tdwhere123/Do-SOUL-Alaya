import {
  mergeFtsLanes,
  splitFtsLanes,
  type FtsLaneHit
} from "@do-soul/alaya-protocol";
import {
  queryFtsLane,
  tokenizeFtsQuery
} from "../../shared/fts-lane-routing.js";
import type {
  EvidenceCapsuleStatements,
  SqliteStatement
} from "../evidence-capsule-statements.js";

export function searchEvidenceByKeyword(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  queryText: string,
  limit: number
): readonly FtsLaneHit[] {
  const trimmed = queryText.trim();
  if (trimmed.length === 0 || !Number.isInteger(limit) || limit <= 0) {
    return Object.freeze([]);
  }
  const tokens = tokenizeFtsQuery(trimmed);
  if (tokens.length === 0) return Object.freeze([]);
  const { porterTokens, trigramTokens } = splitFtsLanes(tokens);
  const porterHits = queryOwnerAndProjectionLane(
    statements.searchByKeywordStatement,
    statements.searchProjectionByKeywordStatement,
    workspaceId,
    porterTokens,
    limit
  );
  const trigramHits = queryOwnerAndProjectionLane(
    statements.searchByKeywordTrigramStatement,
    statements.searchProjectionByKeywordTrigramStatement,
    workspaceId,
    trigramTokens,
    limit
  );
  return mergeFtsLanes(porterHits, trigramHits, limit);
}

function queryOwnerAndProjectionLane(
  ownerStatement: SqliteStatement,
  projectionStatement: SqliteStatement,
  workspaceId: string,
  tokens: readonly string[],
  limit: number
): readonly FtsLaneHit[] {
  if (tokens.length === 0) return Object.freeze([]);
  return mergeFtsLanes(
    queryFtsLane(ownerStatement, workspaceId, tokens, limit),
    queryFtsLane(projectionStatement, workspaceId, tokens, limit),
    limit
  );
}
