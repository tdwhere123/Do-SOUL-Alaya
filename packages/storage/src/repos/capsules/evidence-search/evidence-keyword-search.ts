import {
  rankFtsLaneRows,
  splitFtsLanes,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import {
  buildWorkspaceScopedFtsMatch,
  queryFtsLane,
  tokenizeFtsQuery
} from "../../shared/fts-lane-routing.js";
import type {
  EvidenceCapsuleStatements,
  SqliteStatement
} from "../evidence-capsule-statements.js";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceSearchProjectionIdentity
} from "../evidence-recall-types.js";

export function searchEvidenceByKeyword(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  queryText: string,
  limit: number
): readonly EvidenceCapsuleKeywordHit[] {
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
  return mergeEvidenceHits(porterHits, trigramHits, limit);
}

function queryOwnerAndProjectionLane(
  ownerStatement: SqliteStatement,
  projectionStatement: SqliteStatement,
  workspaceId: string,
  tokens: readonly string[],
  limit: number
): readonly EvidenceCapsuleKeywordHit[] {
  if (tokens.length === 0) return Object.freeze([]);
  return mergeEvidenceHits(
    queryFtsLane(ownerStatement, workspaceId, tokens, limit),
    queryProjectionLane(projectionStatement, workspaceId, tokens, limit),
    limit
  );
}

interface ProjectionRankRow extends FtsLaneRankRow {
  readonly projection_id: number;
  readonly projection_kind: EvidenceSearchProjectionIdentity["projection_kind"];
}

function queryProjectionLane(
  statement: SqliteStatement,
  workspaceId: string,
  tokens: readonly string[],
  limit: number
): readonly EvidenceCapsuleKeywordHit[] {
  const match = buildWorkspaceScopedFtsMatch(workspaceId, tokens);
  const rows = statement.all(workspaceId, match, limit) as readonly ProjectionRankRow[];
  const representatives = selectProjectionRepresentatives(rows);
  const ranked = rankFtsLaneRows(representatives);
  return Object.freeze(ranked.map((hit, index) => Object.freeze({
    ...hit,
    matched_projection: Object.freeze({
      projection_id: representatives[index]!.projection_id,
      projection_kind: representatives[index]!.projection_kind
    })
  })));
}

function selectProjectionRepresentatives(
  rows: readonly ProjectionRankRow[]
): readonly ProjectionRankRow[] {
  const byOwner = new Map<string, ProjectionRankRow>();
  for (const row of rows) {
    const current = byOwner.get(row.object_id);
    if (current === undefined || compareProjectionRows(row, current) < 0) {
      byOwner.set(row.object_id, row);
    }
  }
  return [...byOwner.values()].sort(compareProjectionRanks);
}

function compareProjectionRows(left: ProjectionRankRow, right: ProjectionRankRow): number {
  return left.raw_rank - right.raw_rank ||
    projectionKindPriority(left.projection_kind) -
    projectionKindPriority(right.projection_kind) ||
    left.projection_id - right.projection_id;
}

function compareProjectionRanks(left: ProjectionRankRow, right: ProjectionRankRow): number {
  return left.raw_rank - right.raw_rank ||
    left.object_id.localeCompare(right.object_id) ||
    left.projection_kind.localeCompare(right.projection_kind) ||
    left.projection_id - right.projection_id;
}

function mergeEvidenceHits(
  primaryHits: readonly EvidenceCapsuleKeywordHit[],
  secondaryHits: readonly EvidenceCapsuleKeywordHit[],
  limit: number
): readonly EvidenceCapsuleKeywordHit[] {
  const merged = new Map<string, RankedEvidenceHit>();
  primaryHits.forEach((hit, index) => considerEvidenceHit(merged, hit, 0, index));
  secondaryHits.forEach((hit, index) => considerEvidenceHit(merged, hit, 1, index));
  return Object.freeze([...merged.values()]
    .sort(compareRankedEvidenceHits)
    .slice(0, limit)
    .map(({ hit }) => hit));
}

interface RankedEvidenceHit {
  readonly hit: EvidenceCapsuleKeywordHit;
  readonly lanePriority: number;
  readonly laneOrder: number;
}

function considerEvidenceHit(
  merged: Map<string, RankedEvidenceHit>,
  hit: EvidenceCapsuleKeywordHit,
  lanePriority: number,
  laneOrder: number
): void {
  const candidate = { hit, lanePriority, laneOrder };
  const current = merged.get(hit.object_id);
  if (current === undefined || compareOwnerRepresentatives(candidate, current) < 0) {
    merged.set(hit.object_id, candidate);
  }
}

function compareOwnerRepresentatives(
  left: RankedEvidenceHit,
  right: RankedEvidenceHit
): number {
  return right.hit.normalized_rank - left.hit.normalized_rank ||
    evidenceHitKindPriority(left.hit) - evidenceHitKindPriority(right.hit) ||
    compareRankedEvidenceHits(left, right);
}

function evidenceHitKindPriority(hit: EvidenceCapsuleKeywordHit): number {
  return hit.matched_projection === undefined
    ? 1
    : projectionKindPriority(hit.matched_projection.projection_kind);
}

function projectionKindPriority(
  kind: EvidenceSearchProjectionIdentity["projection_kind"]
): number {
  return kind === "assistant_observation" ? 0 : 2;
}

function compareRankedEvidenceHits(
  left: RankedEvidenceHit,
  right: RankedEvidenceHit
): number {
  const rankDelta = right.hit.normalized_rank - left.hit.normalized_rank;
  if (rankDelta !== 0) return rankDelta;
  const priorityDelta = left.lanePriority - right.lanePriority;
  if (priorityDelta !== 0) return priorityDelta;
  const orderDelta = left.laneOrder - right.laneOrder;
  if (orderDelta !== 0) return orderDelta;
  const objectDelta = left.hit.object_id.localeCompare(right.hit.object_id);
  if (objectDelta !== 0) return objectDelta;
  return compareProjectionIdentity(
    left.hit.matched_projection,
    right.hit.matched_projection
  );
}

function compareProjectionIdentity(
  left: EvidenceSearchProjectionIdentity | undefined,
  right: EvidenceSearchProjectionIdentity | undefined
): number {
  if (left === undefined || right === undefined) {
    return left === undefined ? (right === undefined ? 0 : -1) : 1;
  }
  return left.projection_kind.localeCompare(right.projection_kind) ||
    left.projection_id - right.projection_id;
}
