import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface SurfaceBindingStatements {
  readonly createStatement: SqliteStatement;
  readonly findByBindingIdStatement: SqliteStatement;
  readonly findByObjectIdStatement: SqliteStatement;
  readonly findPrimaryBindingStatement: SqliteStatement;
  readonly findBySurfaceIdStatement: SqliteStatement;
  readonly findByWorkspaceStatement: SqliteStatement;
  readonly updateStateStatement: SqliteStatement;
  readonly findDetachableBySurfaceIdStatement: SqliteStatement;
  readonly findDetachedBySurfaceIdStatement: SqliteStatement;
  readonly cascadeDetachStatement: SqliteStatement;
}

export function prepareSurfaceBindingStatements(db: StorageDatabase): SurfaceBindingStatements {
  return {
    createStatement: db.connection.prepare(CREATE_SURFACE_BINDING_SQL),
    findByBindingIdStatement: db.connection.prepare(selectSurfaceBindingSql("binding_id = ?", undefined, "LIMIT 1")),
    findByObjectIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("object_id = ? AND workspace_id = ?", "created_at ASC, binding_id ASC")
    ),
    findPrimaryBindingStatement: db.connection.prepare(
      selectSurfaceBindingSql(
        "object_id = ? AND workspace_id = ? AND is_primary = 1 AND binding_state != 'detached'",
        undefined,
        "LIMIT 1"
      )
    ),
    findBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("surface_id = ? AND workspace_id = ?", "created_at ASC, binding_id ASC")
    ),
    findByWorkspaceStatement: db.connection.prepare(
      selectSurfaceBindingSql("workspace_id = ?", "created_at ASC, binding_id ASC")
    ),
    updateStateStatement: db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = ?, updated_at = ?
      WHERE binding_id = ?
    `),
    findDetachableBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql(
        "surface_id = ? AND workspace_id = ? AND binding_state != 'detached'",
        "created_at ASC, binding_id ASC"
      )
    ),
    findDetachedBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql(
        "surface_id = ? AND workspace_id = ? AND binding_state = 'detached'",
        "created_at ASC, binding_id ASC"
      )
    ),
    cascadeDetachStatement: db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = 'detached', updated_at = ?
      WHERE surface_id = ? AND workspace_id = ? AND binding_state != 'detached'
    `)
  };
}

function selectSurfaceBindingSql(whereClause: string, orderBy?: string, suffix = ""): string {
  const orderBySql = orderBy === undefined ? "" : `\n      ORDER BY ${orderBy}`;
  const suffixSql = suffix.length === 0 ? "" : `\n      ${suffix}`;
  return `
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE ${whereClause}${orderBySql}${suffixSql}
    `;
}

const SURFACE_BINDING_SELECT_COLUMNS = `
        binding_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        surface_id,
        is_primary,
        binding_state,
        workspace_id
`;

const CREATE_SURFACE_BINDING_SQL = `
      INSERT INTO surface_bindings (
        binding_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        surface_id,
        is_primary,
        binding_state,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
