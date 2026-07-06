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
    findByBindingIdStatement: db.connection.prepare(selectSurfaceBindingSql("byBindingId", undefined, "limitOne")),
    findByObjectIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("byObjectId", "created")
    ),
    findPrimaryBindingStatement: db.connection.prepare(
      selectSurfaceBindingSql("primaryByObjectId", undefined, "limitOne")
    ),
    findBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("bySurfaceId", "created")
    ),
    findByWorkspaceStatement: db.connection.prepare(
      selectSurfaceBindingSql("byWorkspace", "created")
    ),
    updateStateStatement: db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = ?, updated_at = ?
      WHERE binding_id = ?
    `),
    findDetachableBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("detachableBySurfaceId", "created")
    ),
    findDetachedBySurfaceIdStatement: db.connection.prepare(
      selectSurfaceBindingSql("detachedBySurfaceId", "created")
    ),
    cascadeDetachStatement: db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = 'detached', updated_at = ?
      WHERE surface_id = ? AND workspace_id = ? AND binding_state != 'detached'
    `)
  };
}

type SurfaceBindingWhereKey =
  | "byBindingId"
  | "byObjectId"
  | "primaryByObjectId"
  | "bySurfaceId"
  | "byWorkspace"
  | "detachableBySurfaceId"
  | "detachedBySurfaceId";
type SurfaceBindingOrderKey = "created";
type SurfaceBindingSuffixKey = "limitOne";

const SURFACE_BINDING_WHERE_CLAUSES: Readonly<Record<SurfaceBindingWhereKey, string>> = Object.freeze({
  byBindingId: "binding_id = ?",
  byObjectId: "object_id = ? AND workspace_id = ?",
  primaryByObjectId: "object_id = ? AND workspace_id = ? AND is_primary = 1 AND binding_state != 'detached'",
  bySurfaceId: "surface_id = ? AND workspace_id = ?",
  byWorkspace: "workspace_id = ?",
  detachableBySurfaceId: "surface_id = ? AND workspace_id = ? AND binding_state != 'detached'",
  detachedBySurfaceId: "surface_id = ? AND workspace_id = ? AND binding_state = 'detached'"
});

const SURFACE_BINDING_ORDER_BY: Readonly<Record<SurfaceBindingOrderKey, string>> = Object.freeze({
  created: "created_at ASC, binding_id ASC"
});

const SURFACE_BINDING_SUFFIXES: Readonly<Record<SurfaceBindingSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1"
});

function selectSurfaceBindingSql(
  whereKey: SurfaceBindingWhereKey,
  orderByKey?: SurfaceBindingOrderKey,
  suffixKey?: SurfaceBindingSuffixKey
): string {
  const orderBySql = orderByKey === undefined ? "" : `\n      ORDER BY ${SURFACE_BINDING_ORDER_BY[orderByKey]}`;
  const suffixSql = suffixKey === undefined ? "" : `\n      ${SURFACE_BINDING_SUFFIXES[suffixKey]}`;
  return `
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE ${SURFACE_BINDING_WHERE_CLAUSES[whereKey]}${orderBySql}${suffixSql}
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
