import type { StorageDatabase } from "../../sqlite/db.js";
import {
  PATH_RELATION_SELECT_COLUMNS,
  SOURCE_ANCHOR_KEY_SQL,
  TARGET_ANCHOR_KEY_SQL,
  WAVE_1_ACTIVE_LIFECYCLE_SQL,
  WAVE_1_DORMANT_LIFECYCLE_SQL,
  findByBackingObjectIdSql
} from "./path-relation-sql.js";

export interface SqliteStatement {
  readonly source: string;
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface PathRelationStatements {
  readonly createStatement: SqliteStatement;
  readonly updateStatement: SqliteStatement;
  readonly findByIdStatement: SqliteStatement;
  readonly findByWorkspaceStatement: SqliteStatement;
  readonly findByWorkspacePagedStatement: SqliteStatement;
  readonly findBySourceAnchorStatement: SqliteStatement;
  readonly findByTargetAnchorStatement: SqliteStatement;
  readonly findByBackingObjectIdStatement: SqliteStatement;
  readonly findActiveStatement: SqliteStatement;
  readonly findActivePagedStatement: SqliteStatement;
  readonly findDormantStatement: SqliteStatement;
  readonly findDormantPagedStatement: SqliteStatement;
  readonly deleteStatement: SqliteStatement;
}

type PathRelationSqlMap = { readonly [K in keyof PathRelationStatements]: string };
type MutablePathRelationStatements = {
  -readonly [K in keyof PathRelationStatements]: SqliteStatement;
};

const PATH_RELATION_SQL: PathRelationSqlMap = {
  createStatement: `
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
    `,
  updateStatement: `
      UPDATE path_relations
      SET constitution_json = ?,
          effect_vector_json = ?,
          plasticity_state_json = ?,
          lifecycle_json = ?,
          legitimacy_json = ?,
          updated_at = ?
      WHERE path_id = ?
    `,
  findByIdStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE path_id = ?
      LIMIT 1
    `,
  findByWorkspaceStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
      ORDER BY created_at ASC, path_id ASC
    `,
  findByWorkspacePagedStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
      ORDER BY created_at ASC, path_id ASC
      LIMIT ? OFFSET ?
    `,
  findBySourceAnchorStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${SOURCE_ANCHOR_KEY_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `,
  findByTargetAnchorStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${TARGET_ANCHOR_KEY_SQL} = ?
      ORDER BY created_at ASC, path_id ASC
    `,
  findByBackingObjectIdStatement: findByBackingObjectIdSql(),
  findActiveStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_ACTIVE_LIFECYCLE_SQL} = 1
      ORDER BY created_at ASC, path_id ASC
    `,
  findActivePagedStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_ACTIVE_LIFECYCLE_SQL} = 1
      ORDER BY created_at ASC, path_id ASC
      LIMIT ? OFFSET ?
    `,
  findDormantStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_DORMANT_LIFECYCLE_SQL} = 1
        AND updated_at < ?
      ORDER BY created_at ASC, path_id ASC
    `,
  findDormantPagedStatement: `
      SELECT${PATH_RELATION_SELECT_COLUMNS}
      FROM path_relations
      WHERE workspace_id = ?
        AND ${WAVE_1_DORMANT_LIFECYCLE_SQL} = 1
        AND updated_at < ?
      ORDER BY created_at ASC, path_id ASC
      LIMIT ? OFFSET ?
    `,
  deleteStatement: `
      DELETE FROM path_relations
      WHERE path_id = ?
    `
};

export function preparePathRelationStatements(db: StorageDatabase): PathRelationStatements {
  return preparePathRelationStatementGroup(db, PATH_RELATION_SQL);
}

function preparePathRelationStatementGroup(
  db: StorageDatabase,
  sqlByName: PathRelationSqlMap
): PathRelationStatements {
  const statements = {} as MutablePathRelationStatements;
  for (const key of Object.keys(sqlByName) as Array<keyof PathRelationStatements>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements;
}
