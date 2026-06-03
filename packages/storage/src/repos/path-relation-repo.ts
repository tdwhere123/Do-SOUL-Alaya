import {
  PathAnchorRefSchema,
  PathRelationSchema,
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathLifecycleStatus,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface PathRelationRepo {
  create(relation: PathRelation): Readonly<PathRelation>;
  update(
    pathId: string,
    updates: Partial<
      Pick<
        PathRelation,
        "constitution" | "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation>;
  findById(pathId: string): Promise<Readonly<PathRelation> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  /**
   * Dormant paths whose last mutation (`updated_at`) is strictly older than
   * `olderThanIso`. The consolidation planner uses this to find merge/retire
   * candidates that have stayed dormant past the consolidation age window —
   * a path is never consolidated in the same window it went dormant.
   * see also: packages/core/src/consolidation-planner.ts planCycle.
   */
  findDormant(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  delete(pathId: string): Promise<void>;
}

const PATH_RELATION_SELECT_COLUMNS = `
      path_id,
      workspace_id,
      anchors_json,
      constitution_json,
      effect_vector_json,
      plasticity_state_json,
      lifecycle_json,
      legitimacy_json,
      created_at,
      updated_at
`;

// invariant: byte-identical to the CASE/json_array expressions indexed in
// migrations/048-path-relations-and-event-log-indexes.sql. SQLite only uses an
// expression index when the query predicate matches the indexed expression, so
// the anchor-key SQL here MUST stay in lockstep with that index, and the bound
// parameter MUST equal serializePathAnchorRef(...) — json_array(...) renders the
// same text JSON.stringify(["object", id]) produces.
// cross-file ref: migrations/048-path-relations-and-event-log-indexes.sql
// cross-file ref: @do-soul/alaya-protocol serializePathAnchorRef (bound-param side)
function anchorKeySql(anchorPath: "source_anchor" | "target_anchor"): string {
  return `CASE json_extract(anchors_json, '$.${anchorPath}.kind')
      WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.${anchorPath}.object_id'))
      WHEN 'object_facet' THEN json_array(
        'object_facet',
        json_extract(anchors_json, '$.${anchorPath}.object_id'),
        json_extract(anchors_json, '$.${anchorPath}.facet_key')
      )
      WHEN 'obligation' THEN json_array(
        'obligation',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.obligation_digest')
      )
      WHEN 'risk_concern' THEN json_array(
        'risk_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.concern_digest')
      )
      WHEN 'time_concern' THEN json_array(
        'time_concern',
        json_extract(anchors_json, '$.${anchorPath}.source_object_id'),
        json_extract(anchors_json, '$.${anchorPath}.window_digest')
      )
    END`;
}

// invariant: exported so a foreign repo that must match the mint's
// findByAnchorMemoryId/anchorPointsAt dedup against the SAME indexed expression
// reuses this byte-identical text rather than re-spelling the CASE/json_array
// (which would silently drift from migration 048 and lose the expression index).
// see also: edge-proposal-repo.ts listAcceptedAwaitingPath (await-path NOT EXISTS).
export const PATH_RELATION_SOURCE_ANCHOR_KEY_SQL = anchorKeySql("source_anchor");
export const PATH_RELATION_TARGET_ANCHOR_KEY_SQL = anchorKeySql("target_anchor");
const SOURCE_ANCHOR_KEY_SQL = PATH_RELATION_SOURCE_ANCHOR_KEY_SQL;
const TARGET_ANCHOR_KEY_SQL = PATH_RELATION_TARGET_ANCHOR_KEY_SQL;

// invariant: SQL mirror of getPathAnchorBackingObjectId() — object/object_facet
// anchors back on object_id; obligation/risk_concern/time_concern anchors back on
// source_object_id. Consumed by cascade-delete and accepted-edge reconciliation
// to match rows by the backing memory object, not by the full anchor identity.
// Deliberately does NOT ride the composite anchor-key expression indexes: a key
// match would miss memory ids carried as source_object_id by the concern kinds.
// cross-file ref: packages/protocol/src/soul/path-relation.ts getPathAnchorBackingObjectId
// cross-file ref: packages/storage/src/repos/cascade-delete.ts pruneOrphanedPathTopology
// cross-file ref: packages/storage/src/repos/edge-proposal-repo.ts listAcceptedAwaitingPath
function anchorBackingObjectIdSql(anchorPath: "source_anchor" | "target_anchor"): string {
  return `CASE json_extract(anchors_json, '$.${anchorPath}.kind')
      WHEN 'object' THEN json_extract(anchors_json, '$.${anchorPath}.object_id')
      WHEN 'object_facet' THEN json_extract(anchors_json, '$.${anchorPath}.object_id')
      WHEN 'obligation' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
      WHEN 'risk_concern' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
      WHEN 'time_concern' THEN json_extract(anchors_json, '$.${anchorPath}.source_object_id')
    END`;
}

export const PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL = anchorBackingObjectIdSql("source_anchor");
export const PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL = anchorBackingObjectIdSql("target_anchor");

// Single source for the dynamic `findByAnchors` statement so the production
// query and the prepared-statement EXPLAIN guard execute byte-identical SQL.
// cross-file ref: packages/storage/src/__tests__/path-relation-repo.test.ts
function findByAnchorsSql(keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => "?").join(", ");
  return `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND (
          ${SOURCE_ANCHOR_KEY_SQL} IN (${placeholders})
          OR ${TARGET_ANCHOR_KEY_SQL} IN (${placeholders})
        )
      ORDER BY created_at ASC, path_id ASC
    `;
}

function findByBackingObjectIdSql(): string {
  return `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
      UNION ALL
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `;
}

const WAVE_1_ACTIVE_LIFECYCLE_SQL = `CASE
      WHEN json_valid(lifecycle_json) = 0 THEN 0
      WHEN json_type(lifecycle_json, '$.retirement_rule') IS NULL
        OR json_type(lifecycle_json, '$.retirement_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.cooldown_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.cooldown_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.override_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.override_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.status') IS NOT NULL
        AND json_type(lifecycle_json, '$.status') != 'text' THEN 0
      WHEN COALESCE(json_extract(lifecycle_json, '$.status'), 'active') != 'active' THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM json_each(lifecycle_json)
        WHERE key NOT IN ('status', 'retirement_rule', 'cooldown_rule', 'override_rule')
      ) THEN 0
      ELSE 1
    END`;

// Mirrors WAVE_1_ACTIVE_LIFECYCLE_SQL but matches the dormant landing state:
// a well-formed lifecycle whose status is exactly "dormant". Unlike active,
// dormant must be set explicitly (no unset-defaults-to-dormant fallback).
const WAVE_1_DORMANT_LIFECYCLE_SQL = `CASE
      WHEN json_valid(lifecycle_json) = 0 THEN 0
      WHEN json_type(lifecycle_json, '$.retirement_rule') IS NULL
        OR json_type(lifecycle_json, '$.retirement_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.cooldown_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.cooldown_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.override_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.override_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.status') IS NULL
        OR json_type(lifecycle_json, '$.status') != 'text' THEN 0
      WHEN json_extract(lifecycle_json, '$.status') != 'dormant' THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM json_each(lifecycle_json)
        WHERE key NOT IN ('status', 'retirement_rule', 'cooldown_rule', 'override_rule')
      ) THEN 0
      ELSE 1
    END`;

interface PathRelationRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: PathLifecycleStatus;
};

export class SqlitePathRelationRepo implements PathRelationRepo {
  private readonly createStatement;
  private readonly updateStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly findBySourceAnchorStatement;
  private readonly findByTargetAnchorStatement;
  private readonly findByBackingObjectIdStatement;
  private readonly findActiveStatement;
  private readonly findDormantStatement;
  private readonly deleteStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateStatement = db.connection.prepare(`
      UPDATE path_relations
      SET constitution_json = ?,
          effect_vector_json = ?,
          plasticity_state_json = ?,
          lifecycle_json = ?,
          legitimacy_json = ?,
          updated_at = ?
      WHERE path_id = ?
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE path_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
      ORDER BY created_at ASC, path_id ASC
    `);

    this.findBySourceAnchorStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${SOURCE_ANCHOR_KEY_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `);

    this.findByTargetAnchorStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${TARGET_ANCHOR_KEY_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `);

    this.findByBackingObjectIdStatement = db.connection.prepare(findByBackingObjectIdSql());

    this.findActiveStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_ACTIVE_LIFECYCLE_SQL} = 1
      ORDER BY created_at ASC, path_id ASC
    `);

    this.findDormantStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_DORMANT_LIFECYCLE_SQL} = 1
        AND updated_at < ?
      ORDER BY created_at ASC, path_id ASC
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM path_relations
      WHERE path_id = ?
    `);
  }

  public create(relation: PathRelation): Readonly<PathRelation> {
    const parsedRelation = parsePathRelation(relation);

    try {
      this.createStatement.run(
        parsedRelation.path_id,
        parsedRelation.workspace_id,
        JSON.stringify(parsedRelation.anchors),
        JSON.stringify(parsedRelation.constitution),
        JSON.stringify(parsedRelation.effect_vector),
        JSON.stringify(parsedRelation.plasticity_state),
        JSON.stringify(parsedRelation.lifecycle),
        JSON.stringify(parsedRelation.legitimacy),
        parsedRelation.created_at,
        parsedRelation.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert path relation ${parsedRelation.path_id}.`,
        error
      );
    }

    let row: PathRelationRow | undefined;
    try {
      row = this.findByIdStatement.get(parsedRelation.path_id) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load path relation ${parsedRelation.path_id}.`,
        error
      );
    }

    if (row === undefined) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedRelation.path_id} was not found after insert.`
      );
    }

    return parsePathRelationRow(row);
  }

  /**
   * Required by `PathPlasticityService` so that `appendManyWithMutation`
   * can wrap the EventLog row and the `path_relation` mutation in one
   * SQLite transaction, closing the race for path-relation writes.
   */
  public update(
    pathId: string,
    updates: Partial<
      Pick<
        PathRelation,
        "constitution" | "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");

    let existingRow: PathRelationRow | undefined;
    try {
      existingRow = this.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load path relation ${parsedPathId}.`, error);
    }

    if (existingRow === undefined) {
      throw new StorageError("NOT_FOUND", `Path relation ${parsedPathId} was not found.`);
    }

    const existing = parsePathRelationRow(existingRow);

    const nextRelation = parsePathRelation({
      ...existing,
      constitution: updates.constitution ?? existing.constitution,
      effect_vector: updates.effect_vector ?? existing.effect_vector,
      plasticity_state: updates.plasticity_state ?? existing.plasticity_state,
      lifecycle: updates.lifecycle ?? existing.lifecycle,
      legitimacy: updates.legitimacy ?? existing.legitimacy,
      updated_at: updates.updated_at ?? existing.updated_at
    });

    try {
      const changes = this.updateStatement.run(
        JSON.stringify(nextRelation.constitution),
        JSON.stringify(nextRelation.effect_vector),
        JSON.stringify(nextRelation.plasticity_state),
        JSON.stringify(nextRelation.lifecycle),
        JSON.stringify(nextRelation.legitimacy),
        nextRelation.updated_at,
        parsedPathId
      ).changes;

      if (changes === 0) {
        throw new StorageError("NOT_FOUND", `Path relation ${parsedPathId} was not found.`);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update path relation ${parsedPathId}.`,
        error
      );
    }

    let updatedRow: PathRelationRow | undefined;
    try {
      updatedRow = this.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to reload path relation ${parsedPathId} after update.`,
        error
      );
    }

    if (updatedRow === undefined) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedPathId} was not found after update.`
      );
    }

    return parsePathRelationRow(updatedRow);
  }

  public async findById(pathId: string): Promise<Readonly<PathRelation> | null> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");

    try {
      const row = this.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
      return row === undefined ? null : parsePathRelationRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to load path relation ${parsedPathId}.`, error);
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as PathRelationRow[];
      return parsePathRelationRows(rows);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list path relations for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedAnchor = parsePathAnchorRef(anchorRef);
    const anchorKey = serializePathAnchorRef(parsedAnchor);

    try {
      const sourceRows = this.findBySourceAnchorStatement.all(parsedWorkspaceId, anchorKey) as PathRelationRow[];
      const targetRows = this.findByTargetAnchorStatement.all(parsedWorkspaceId, anchorKey) as PathRelationRow[];
      return parsePathRelationRows([...sourceRows, ...targetRows], { dedupe: true });
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to list path relations by anchor.", error);
    }
  }

  // Inbound-only lookup: rows whose TARGET anchor equals the given ref. Unlike
  // `findByAnchor` (source+target union) this scopes to the inbound half, which
  // recall graph_support needs to count paths arriving at a candidate memory.
  // No lifecycle filter is applied here; callers apply isPathRecallEligible.
  // see also: packages/core/src/graph-explore-service.ts countInbound*.
  public async findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedAnchor = parsePathAnchorRef(anchorRef);
    const anchorKey = serializePathAnchorRef(parsedAnchor);

    try {
      const rows = this.findByTargetAnchorStatement.all(parsedWorkspaceId, anchorKey) as PathRelationRow[];
      return parsePathRelationRows(rows);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to list path relations by target anchor.", error);
    }
  }

  public async findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const anchorKeys = [...new Set(anchorRefs.map((anchorRef) => serializePathAnchorRef(parsePathAnchorRef(anchorRef))))];

    if (anchorKeys.length === 0) {
      return deepFreeze([]);
    }

    const statement = this.db.connection.prepare(findByAnchorsSql(anchorKeys.length));

    try {
      const rows = statement.all(
        parsedWorkspaceId,
        ...anchorKeys,
        ...anchorKeys
      ) as PathRelationRow[];
      return parsePathRelationRows(rows, { dedupe: true });
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to list path relations by anchors.", error);
    }
  }

  public async findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedObjectId = parseNonEmptyString(objectId, "object id");

    try {
      const rows = this.findByBackingObjectIdStatement.all(
        parsedWorkspaceId,
        parsedObjectId,
        parsedWorkspaceId,
        parsedObjectId
      ) as PathRelationRow[];
      return parsePathRelationRows(rows, { dedupe: true });
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list path relations by backing object id for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findActiveStatement.all(parsedWorkspaceId) as PathRelationRow[];
      return parsePathRelationRows(rows);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list active path relations for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findDormant(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedOlderThanIso = parseNonEmptyString(olderThanIso, "older-than timestamp");

    try {
      const rows = this.findDormantStatement.all(
        parsedWorkspaceId,
        parsedOlderThanIso
      ) as PathRelationRow[];
      return parsePathRelationRows(rows);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list dormant path relations for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async delete(pathId: string): Promise<void> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");

    try {
      this.deleteStatement.run(parsedPathId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete path relation ${parsedPathId}.`, error);
    }
  }

  // Test-only seam: the SQL text the repo actually prepared for its anchor
  // lookups. Returning .source from the live prepared statements lets the
  // EXPLAIN QUERY PLAN guard prove the planner rides the migration 048
  // expression indexes against the REAL statements, not a reconstruction that
  // could silently drift from them. findByAnchors builds its statement per
  // call, so it is rendered through the same shared findByAnchorsSql builder.
  // cross-file ref: packages/storage/src/__tests__/path-relation-repo.test.ts
  public __anchorLookupSqlForTest(): Readonly<{
    readonly findBySourceAnchor: string;
    readonly findByTargetAnchor: string;
    readonly findByAnchors: (keyCount: number) => string;
    readonly findByBackingObjectId: string;
  }> {
    return Object.freeze({
      findBySourceAnchor: (this.findBySourceAnchorStatement as { readonly source: string }).source,
      findByTargetAnchor: (this.findByTargetAnchorStatement as { readonly source: string }).source,
      findByAnchors: (keyCount: number) => findByAnchorsSql(keyCount),
      findByBackingObjectId: (this.findByBackingObjectIdStatement as { readonly source: string }).source
    });
  }
}

function parsePathRelation(value: PathRelation): Readonly<PathRelation> {
  try {
    return deepFreeze(PathRelationSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path relation.", error);
  }
}

function parsePathAnchorRef(value: PathAnchorRef): Readonly<PathAnchorRef> {
  try {
    return deepFreeze(PathAnchorRefSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path anchor ref.", error);
  }
}


function parsePathRelationRow(row: PathRelationRow): Readonly<PathRelation> {
  return parsePathRelation({
    path_id: row.path_id,
    workspace_id: row.workspace_id,
    anchors: parseJsonField<PathRelation["anchors"]>(row.anchors_json, "anchors"),
    constitution: parseJsonField<PathRelation["constitution"]>(row.constitution_json, "constitution"),
    effect_vector: parseJsonField<PathRelation["effect_vector"]>(row.effect_vector_json, "effect_vector"),
    plasticity_state: parseJsonField<PathRelation["plasticity_state"]>(
      row.plasticity_state_json,
      "plasticity_state"
    ),
    lifecycle: normalizeLifecycle(parseJsonField<PathRelation["lifecycle"]>(row.lifecycle_json, "lifecycle")),
    legitimacy: parseJsonField<PathRelation["legitimacy"]>(row.legitimacy_json, "legitimacy"),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function normalizeLifecycle(lifecycle: PathRelation["lifecycle"]): PathRelation["lifecycle"] {
  const lifecycleWithStatus = lifecycle as PathLifecycleWithStatus;
  return {
    status: lifecycleWithStatus.status ?? "active",
    retirement_rule: lifecycle.retirement_rule,
    ...(lifecycle.cooldown_rule === undefined ? {} : { cooldown_rule: lifecycle.cooldown_rule }),
    ...(lifecycle.override_rule === undefined ? {} : { override_rule: lifecycle.override_rule })
  } as PathRelation["lifecycle"];
}

function parsePathRelationRows(
  rows: readonly PathRelationRow[],
  options: {
    readonly dedupe?: boolean;
  } = {}
): readonly Readonly<PathRelation>[] {
  const relations = rows.map((row) => parsePathRelationRow(row));

  if (!options.dedupe) {
    return deepFreeze(relations);
  }

  const deduped = new Map<string, Readonly<PathRelation>>();
  for (const relation of relations) {
    deduped.set(relation.path_id, relation);
  }

  return deepFreeze(
    [...deduped.values()].sort((left, right) => comparePathRelationOrder(left, right))
  );
}

function comparePathRelationOrder(left: Readonly<PathRelation>, right: Readonly<PathRelation>): number {
  if (left.created_at === right.created_at) {
    return left.path_id.localeCompare(right.path_id);
  }

  return left.created_at.localeCompare(right.created_at);
}

function parseJsonField<T>(value: string, fieldName: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse path relation ${fieldName}.`,
      error
    );
  }
}
