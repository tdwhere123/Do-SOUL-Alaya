import {
  PathAnchorRefSchema,
  PathRelationSchema,
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { SqliteConnection, StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface PathRelationRepo {
  create(relation: PathRelation): Promise<Readonly<PathRelation>>;
  update(
    pathId: string,
    updates: Partial<
      Pick<PathRelation, "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
    >
  ): Promise<Readonly<PathRelation>>;
  findById(pathId: string): Promise<Readonly<PathRelation> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
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

const SOURCE_ANCHOR_KEY_SQL =
  "serialize_path_anchor_ref(json_extract(anchors_json, '$.source_anchor'))";
const TARGET_ANCHOR_KEY_SQL =
  "serialize_path_anchor_ref(json_extract(anchors_json, '$.target_anchor'))";

const WAVE_1_ACTIVE_LIFECYCLE_SQL = `CASE
      WHEN json_valid(lifecycle_json) = 0 THEN 0
      WHEN json_type(lifecycle_json, '$.retirement_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.cooldown_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.cooldown_rule') != 'text' THEN 0
      WHEN json_type(lifecycle_json, '$.override_rule') IS NOT NULL
        AND json_type(lifecycle_json, '$.override_rule') != 'text' THEN 0
      WHEN EXISTS (
        SELECT 1
        FROM json_each(lifecycle_json)
        WHERE key NOT IN ('retirement_rule', 'cooldown_rule', 'override_rule')
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

export class SqlitePathRelationRepo implements PathRelationRepo {
  private readonly createStatement;
  private readonly updateStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly findBySourceAnchorStatement;
  private readonly findByTargetAnchorStatement;
  private readonly findActiveStatement;
  private readonly deleteStatement;

  public constructor(private readonly db: StorageDatabase) {
    registerSerializePathAnchorRefFunction(db.connection);
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
      SET effect_vector_json = ?,
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

    this.findActiveStatement = db.connection.prepare(`
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_ACTIVE_LIFECYCLE_SQL} = 1
      ORDER BY created_at ASC, path_id ASC
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM path_relations
      WHERE path_id = ?
    `);
  }

  public async create(relation: PathRelation): Promise<Readonly<PathRelation>> {
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

    const inserted = await this.findById(parsedRelation.path_id);

    if (inserted === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedRelation.path_id} was not found after insert.`
      );
    }

    return inserted;
  }

  public async update(
    pathId: string,
    updates: Partial<
      Pick<PathRelation, "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
    >
  ): Promise<Readonly<PathRelation>> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");
    const existing = await this.findById(parsedPathId);

    if (existing === null) {
      throw new StorageError("NOT_FOUND", `Path relation ${parsedPathId} was not found.`);
    }

    const nextRelation = parsePathRelation({
      ...existing,
      effect_vector: updates.effect_vector ?? existing.effect_vector,
      plasticity_state: updates.plasticity_state ?? existing.plasticity_state,
      lifecycle: updates.lifecycle ?? existing.lifecycle,
      legitimacy: updates.legitimacy ?? existing.legitimacy,
      updated_at: updates.updated_at ?? existing.updated_at
    });

    try {
      const changes = this.updateStatement.run(
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

    const updated = await this.findById(parsedPathId);

    if (updated === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Path relation ${parsedPathId} was not found after update.`
      );
    }

    return updated;
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

  public async delete(pathId: string): Promise<void> {
    const parsedPathId = parseNonEmptyString(pathId, "path id");

    try {
      this.deleteStatement.run(parsedPathId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete path relation ${parsedPathId}.`, error);
    }
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

function registerSerializePathAnchorRefFunction(connection: SqliteConnection): void {
  connection.function(
    "serialize_path_anchor_ref",
    { deterministic: true },
    (anchorJson: string | null): string | null => {
      if (typeof anchorJson !== "string" || anchorJson.length === 0) {
        return null;
      }

      try {
        return serializePathAnchorRef(parsePathAnchorRef(JSON.parse(anchorJson)));
      } catch {
        return null;
      }
    }
  );
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
    lifecycle: parseJsonField<PathRelation["lifecycle"]>(row.lifecycle_json, "lifecycle"),
    legitimacy: parseJsonField<PathRelation["legitimacy"]>(row.legitimacy_json, "legitimacy"),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
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
