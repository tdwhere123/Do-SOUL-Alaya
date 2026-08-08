import {
  mergeFtsLaneIds,
  rankFtsLaneRows,
  splitFtsLanes,
  type FtsLaneId,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import {
  buildWorkspaceScopedFtsMatch,
  tokenizeFtsQuery
} from "../../shared/fts-lane-routing.js";
import {
  buildMonotoneFieldRefinementLevels,
  preserveFieldLaneObservationPrefix
} from
  "../../shared/monotone-field-refinement.js";
import type {
  EvidenceCapsuleStatements,
  SqliteStatement
} from "../evidence-capsule-statements.js";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceKeywordFieldResult,
  EvidenceSearchProjectionIdentity
} from "../evidence-recall-types.js";

type EvidenceFtsLane = Exclude<FtsLaneId, "exact">;

export function searchEvidenceByKeyword(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  queryText: string,
  limit: number
): readonly EvidenceCapsuleKeywordHit[] {
  return searchEvidenceByKeywordField(statements, workspaceId, queryText, limit).matches;
}

export function searchEvidenceByKeywordField(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  queryText: string,
  limit: number,
  refinementDepths: readonly number[] = []
): Readonly<EvidenceKeywordFieldResult> {
  const trimmed = queryText.trim();
  if (trimmed.length === 0 || !Number.isInteger(limit) || limit <= 0) {
    return ineligibleEvidenceField();
  }
  const tokens = tokenizeFtsQuery(trimmed);
  if (tokens.length === 0) return ineligibleEvidenceField();
  const { porterTokens, trigramTokens } = splitFtsLanes(tokens);
  const depths = normalizeRefinementDepths(limit, refinementDepths);
  const maxDepth = depths.at(-1) ?? limit;
  const porterRows = queryOwnerAndProjectionRows(
    statements.searchByKeywordStatement,
    statements.searchProjectionByKeywordStatement,
    workspaceId,
    porterTokens,
    maxDepth
  );
  const trigramRows = queryOwnerAndProjectionRows(
    statements.searchByKeywordTrigramStatement,
    statements.searchProjectionByKeywordTrigramStatement,
    workspaceId,
    trigramTokens,
    maxDepth
  );
  const base = buildEvidenceFieldView(
    porterRows, trigramRows, limit, porterTokens.length > 0, trigramTokens.length > 0
  );
  return Object.freeze({
    ...base,
    ...(depths.length === 0 ? {} : {
      refinement_levels: preserveEvidenceLanePrefixes(
        base.lanes,
        buildMonotoneFieldRefinementLevels(
          base.matches,
          depths,
          (depth) => buildEvidenceFieldView(
            porterRows, trigramRows, depth,
            porterTokens.length > 0, trigramTokens.length > 0
          )
        )
      )
    })
  });
}

function preserveEvidenceLanePrefixes(
  baseLanes: EvidenceKeywordFieldResult["lanes"],
  levels: NonNullable<EvidenceKeywordFieldResult["refinement_levels"]>
): NonNullable<EvidenceKeywordFieldResult["refinement_levels"]> {
  let previousLanes = baseLanes;
  return Object.freeze(levels.map((level) => {
    const lanes = Object.freeze(level.lanes.map((lane, index) => {
      const previous = previousLanes[index];
      if (previous === undefined || previous.lane !== lane.lane) {
        throw new Error("evidence field lane catalog changed within one observation");
      }
      if (previous.status !== "truncated") return lane;
      const observations = preserveFieldLaneObservationPrefix(
        previous.observations,
        lane.observations
      );
      return Object.freeze({ ...lane, depth: observations.length, observations });
    }));
    previousLanes = lanes;
    return Object.freeze({ ...level, lanes });
  }));
}

type EvidenceLaneRows = Readonly<{
  readonly owners: readonly FtsLaneRankRow[];
  readonly projections: readonly ProjectionRankRow[];
}>;

function buildEvidenceFieldView(
  porterRows: EvidenceLaneRows,
  trigramRows: EvidenceLaneRows,
  depth: number,
  porterEligible: boolean,
  trigramEligible: boolean
) {
  const porterHits = buildEvidenceLaneHits(porterRows, "porter", depth);
  const trigramHits = buildEvidenceLaneHits(trigramRows, "trigram", depth);
  return Object.freeze({
    matches: mergeEvidenceHits(porterHits, trigramHits, depth),
    lanes: Object.freeze([
      ineligibleEvidenceLane("exact"),
      buildEvidenceLane(
        "porter", porterHits, depth, porterEligible, laneRowsTruncated(porterRows, depth)
      ),
      buildEvidenceLane(
        "trigram", trigramHits, depth, trigramEligible, laneRowsTruncated(trigramRows, depth)
      )
    ])
  });
}

function buildEvidenceLane(
  lane: "porter" | "trigram",
  hits: readonly Readonly<EvidenceCapsuleKeywordHit>[],
  limit: number,
  eligible: boolean,
  truncated: boolean
) {
  if (!eligible) return ineligibleEvidenceLane(lane);
  const observations = Object.freeze(hits.slice(0, limit).map((hit, index) => Object.freeze({
    ...hit,
    rank: index + 1,
    source_id: evidenceHitSourceId(hit)
  })));
  return Object.freeze({
    lane,
    status: truncated ? "truncated" as const : "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: truncated ? 1 : 0
  });
}

function evidenceHitSourceId(hit: Readonly<EvidenceCapsuleKeywordHit>): string {
  const projection = hit.matched_projection;
  return projection === undefined
    ? `owner:${hit.object_id}`
    : `projection:${hit.object_id}:${projection.projection_kind}:${projection.projection_id}`;
}

function ineligibleEvidenceField(): Readonly<EvidenceKeywordFieldResult> {
  return Object.freeze({
    matches: Object.freeze([]),
    lanes: Object.freeze([
      ineligibleEvidenceLane("exact"),
      ineligibleEvidenceLane("porter"),
      ineligibleEvidenceLane("trigram")
    ])
  });
}

function ineligibleEvidenceLane(lane: "exact" | "porter" | "trigram") {
  return Object.freeze({
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function queryOwnerAndProjectionRows(
  ownerStatement: SqliteStatement,
  projectionStatement: SqliteStatement,
  workspaceId: string,
  tokens: readonly string[],
  limit: number
): EvidenceLaneRows {
  if (tokens.length === 0) {
    return Object.freeze({ owners: Object.freeze([]), projections: Object.freeze([]) });
  }
  const match = buildWorkspaceScopedFtsMatch(workspaceId, tokens);
  return Object.freeze({
    owners: Object.freeze(ownerStatement.all(
      workspaceId, match, limit
    ) as readonly FtsLaneRankRow[]),
    projections: Object.freeze(projectionStatement.all(
      workspaceId, match, limit
    ) as readonly ProjectionRankRow[])
  });
}

interface ProjectionRankRow extends FtsLaneRankRow {
  readonly projection_id: number;
  readonly projection_kind: EvidenceSearchProjectionIdentity["projection_kind"];
  readonly projection_content: string;
  readonly owner_content: string;
  readonly owner_gist: string;
  readonly source_hash: string;
}

function buildEvidenceLaneHits(
  rows: EvidenceLaneRows,
  lane: EvidenceFtsLane,
  depth: number
): readonly EvidenceCapsuleKeywordHit[] {
  const ownerHits = rankFtsLaneRows(rows.owners.slice(0, depth)).map((hit) =>
    Object.freeze({ ...hit, matched_fts_lanes: Object.freeze([lane]) })
  );
  return mergeEvidenceHits(
    ownerHits,
    buildProjectionLane(rows.projections.slice(0, depth), lane),
    depth
  );
}

function buildProjectionLane(
  rows: readonly ProjectionRankRow[],
  lane: EvidenceFtsLane
): readonly EvidenceCapsuleKeywordHit[] {
  const representatives = selectProjectionRepresentatives(rows);
  const ranked = rankFtsLaneRows(representatives);
  return Object.freeze(ranked.map((hit, index) => Object.freeze({
    ...hit,
    matched_fts_lanes: Object.freeze([lane]),
    matched_projection: Object.freeze({
      projection_id: representatives[index]!.projection_id,
      projection_kind: representatives[index]!.projection_kind
    })
  })));
}

function laneRowsTruncated(rows: EvidenceLaneRows, depth: number): boolean {
  return rows.owners.length >= depth || rows.projections.length >= depth;
}

function normalizeRefinementDepths(
  baseDepth: number,
  depths: readonly number[]
): readonly number[] {
  const normalized = [...new Set(depths)].sort((left, right) => left - right);
  if (normalized.some((depth) => !Number.isSafeInteger(depth) || depth <= baseDepth)) {
    throw new RangeError("field refinement depths must be increasing above the base depth");
  }
  return Object.freeze(normalized);
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
    compareProjectionContent(left, right) ||
    left.source_hash.localeCompare(right.source_hash) ||
    left.projection_id - right.projection_id;
}

function compareProjectionRanks(left: ProjectionRankRow, right: ProjectionRankRow): number {
  return left.raw_rank - right.raw_rank ||
    left.owner_content.localeCompare(right.owner_content) ||
    left.owner_gist.localeCompare(right.owner_gist) ||
    left.source_hash.localeCompare(right.source_hash) ||
    compareProjectionContent(left, right) ||
    left.projection_id - right.projection_id ||
    left.object_id.localeCompare(right.object_id);
}

function compareProjectionContent(left: ProjectionRankRow, right: ProjectionRankRow): number {
  return projectionKindPriority(left.projection_kind) -
    projectionKindPriority(right.projection_kind) ||
    left.projection_content.localeCompare(right.projection_content);
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
  if (current !== undefined && sameEvidenceHitIdentity(current.hit, hit)) {
    const preferred = compareOwnerRepresentatives(candidate, current) < 0
      ? candidate
      : current;
    merged.set(hit.object_id, {
      ...preferred,
      hit: Object.freeze({
        ...preferred.hit,
        matched_fts_lanes: mergeFtsLaneIds(
          current.hit.matched_fts_lanes,
          hit.matched_fts_lanes
        )
      })
    });
    return;
  }
  if (current === undefined || compareOwnerRepresentatives(candidate, current) < 0) {
    merged.set(hit.object_id, candidate);
  }
}

function sameEvidenceHitIdentity(
  left: EvidenceCapsuleKeywordHit,
  right: EvidenceCapsuleKeywordHit
): boolean {
  return compareProjectionIdentity(
    left.matched_projection,
    right.matched_projection
  ) === 0;
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
