import {
  EvidenceSearchProjectionKindSchema,
  splitFtsLanes,
  type FtsLaneRankRow
} from "@do-soul/alaya-protocol";
import {
  buildWorkspaceScopedFtsMatch,
  tokenizeFtsQuery
} from "../../shared/fts-lane-routing.js";
import { FtsLaneRankRowParser } from "../../shared/sqlite-row-schemas.js";
import {
  parseRows,
  readFiniteNumberField,
  readNonEmptyStringField,
  readPositiveIntField,
  readRecord,
  readStringField,
  type RowParser
} from "../../shared/parse-row.js";
import type {
  EvidenceCapsuleStatements,
  SqliteStatement
} from "../evidence-capsule-statements.js";
import type { EvidenceCapsuleKeywordHit, EvidenceKeywordFieldResult } from
  "../evidence-recall-types.js";
import {
  buildEvidenceKeywordFieldResult,
  ineligibleEvidenceField,
  normalizeRefinementDepths
} from "./evidence-keyword-merge.js";
import type {
  EvidenceFtsLane,
  EvidenceKeywordLaneBundle,
  EvidenceLaneRows,
  ProjectionRankRow
} from "./evidence-keyword-types.js";

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
  const lanes = collectEvidenceKeywordLaneRows(
    statements, workspaceId, porterTokens, trigramTokens, maxDepth
  );
  return buildEvidenceKeywordFieldResult(
    lanes, limit, depths, porterTokens.length > 0, trigramTokens.length > 0
  );
}

export function collectEvidenceKeywordLaneRows(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  porterTokens: readonly string[],
  trigramTokens: readonly string[],
  limit: number
): EvidenceKeywordLaneBundle {
  if (porterTokens.length > 0 && trigramTokens.length > 0) {
    return collectEvidenceKeywordLaneRowsUnion(
      statements, workspaceId, porterTokens, trigramTokens, limit
    );
  }
  return collectEvidenceKeywordLaneRowsSeparate(
    statements, workspaceId, porterTokens, trigramTokens, limit
  );
}

export function collectEvidenceKeywordLaneRowsSeparate(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  porterTokens: readonly string[],
  trigramTokens: readonly string[],
  limit: number
): EvidenceKeywordLaneBundle {
  return Object.freeze({
    porter: queryOwnerAndProjectionRows(
      statements.searchByKeywordStatement,
      statements.searchProjectionByKeywordStatement,
      workspaceId,
      porterTokens,
      limit
    ),
    trigram: queryOwnerAndProjectionRows(
      statements.searchByKeywordTrigramStatement,
      statements.searchProjectionByKeywordTrigramStatement,
      workspaceId,
      trigramTokens,
      limit
    )
  });
}

export function collectEvidenceKeywordLaneRowsUnion(
  statements: EvidenceCapsuleStatements,
  workspaceId: string,
  porterTokens: readonly string[],
  trigramTokens: readonly string[],
  limit: number
): EvidenceKeywordLaneBundle {
  if (porterTokens.length === 0 || trigramTokens.length === 0) {
    throw new Error("union evidence FTS lanes require both porter and trigram tokens");
  }
  const porterMatch = buildWorkspaceScopedFtsMatch(workspaceId, porterTokens);
  const trigramMatch = buildWorkspaceScopedFtsMatch(workspaceId, trigramTokens);
  return splitTaggedLaneRows(
    parseRows(
      statements.searchOwnerByKeywordUnionStatement.all(
        workspaceId, porterMatch, limit, workspaceId, trigramMatch, limit
      ),
      TaggedOwnerRowParser,
      "evidence fts owner union row"
    ),
    parseRows(
      statements.searchProjectionByKeywordUnionStatement.all(
        workspaceId, porterMatch, limit, workspaceId, trigramMatch, limit
      ),
      TaggedProjectionRowParser,
      "evidence fts projection union row"
    )
  );
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
    owners: Object.freeze(parseRows(
      ownerStatement.all(workspaceId, match, limit),
      FtsLaneRankRowParser,
      "evidence fts owner row"
    )),
    projections: Object.freeze(parseRows(
      projectionStatement.all(workspaceId, match, limit),
      ProjectionRankRowParser,
      "evidence fts projection row"
    ))
  });
}

interface TaggedOwnerRow extends FtsLaneRankRow {
  readonly fts_lane: EvidenceFtsLane;
}

interface TaggedProjectionRow extends ProjectionRankRow {
  readonly fts_lane: EvidenceFtsLane;
}

const ProjectionRankRowParser: RowParser<ProjectionRankRow> = {
  parse(value: unknown): ProjectionRankRow {
    const record = readRecord(value, "evidence fts projection row");
    return Object.freeze({
      object_id: readNonEmptyStringField(record, "object_id"),
      raw_rank: readFiniteNumberField(record, "raw_rank"),
      projection_id: readPositiveIntField(record, "projection_id"),
      projection_kind: EvidenceSearchProjectionKindSchema.parse(
        readNonEmptyStringField(record, "projection_kind")
      ),
      projection_content: readStringField(record, "projection_content"),
      owner_content: readStringField(record, "owner_content"),
      owner_gist: readStringField(record, "owner_gist"),
      source_hash: readStringField(record, "source_hash")
    });
  }
};

const TaggedOwnerRowParser: RowParser<TaggedOwnerRow> = {
  parse(value: unknown): TaggedOwnerRow {
    const record = readRecord(value, "evidence fts owner union row");
    const lane = readNonEmptyStringField(record, "fts_lane");
    if (lane !== "porter" && lane !== "trigram") {
      throw new Error(`evidence fts owner union row: invalid fts_lane ${lane}`);
    }
    return Object.freeze({
      ...FtsLaneRankRowParser.parse(value),
      fts_lane: lane
    });
  }
};

const TaggedProjectionRowParser: RowParser<TaggedProjectionRow> = {
  parse(value: unknown): TaggedProjectionRow {
    const record = readRecord(value, "evidence fts projection union row");
    const lane = readNonEmptyStringField(record, "fts_lane");
    if (lane !== "porter" && lane !== "trigram") {
      throw new Error(`evidence fts projection union row: invalid fts_lane ${lane}`);
    }
    return Object.freeze({
      ...ProjectionRankRowParser.parse(value),
      fts_lane: lane
    });
  }
};

function splitTaggedLaneRows(
  ownerRows: readonly TaggedOwnerRow[],
  projectionRows: readonly TaggedProjectionRow[]
): EvidenceKeywordLaneBundle {
  return Object.freeze({
    porter: collectTaggedLane(ownerRows, projectionRows, "porter"),
    trigram: collectTaggedLane(ownerRows, projectionRows, "trigram")
  });
}

function collectTaggedLane(
  ownerRows: readonly TaggedOwnerRow[],
  projectionRows: readonly TaggedProjectionRow[],
  lane: EvidenceFtsLane
): EvidenceLaneRows {
  return Object.freeze({
    owners: Object.freeze(
      ownerRows.filter((row) => row.fts_lane === lane).map(toOwnerRow)
    ),
    projections: Object.freeze(
      projectionRows.filter((row) => row.fts_lane === lane).map(toProjectionRow)
    )
  });
}

function toOwnerRow(row: TaggedOwnerRow): FtsLaneRankRow {
  return Object.freeze({
    object_id: row.object_id,
    raw_rank: row.raw_rank
  });
}

function toProjectionRow(row: TaggedProjectionRow): ProjectionRankRow {
  return Object.freeze({
    object_id: row.object_id,
    raw_rank: row.raw_rank,
    projection_id: row.projection_id,
    projection_kind: row.projection_kind,
    projection_content: row.projection_content,
    owner_content: row.owner_content,
    owner_gist: row.owner_gist,
    source_hash: row.source_hash
  });
}
