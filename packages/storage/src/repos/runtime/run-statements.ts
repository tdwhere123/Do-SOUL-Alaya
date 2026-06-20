import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface RunStatements {
  readonly createStatement: SqliteStatement;
  readonly getByIdStatement: SqliteStatement;
  readonly listByWorkspaceStatement: SqliteStatement;
  readonly listByWorkspacePagedStatement: SqliteStatement;
  readonly countByWorkspaceStatement: SqliteStatement;
  readonly updateStateStatement: SqliteStatement;
  readonly updateTitleStatement: SqliteStatement;
}

export function prepareRunStatements(db: StorageDatabase): RunStatements {
  return {
    createStatement: db.connection.prepare(CREATE_RUN_SQL),
    getByIdStatement: db.connection.prepare(selectRunSql("run_id = ?", undefined, "LIMIT 1")),
    listByWorkspaceStatement: db.connection.prepare(selectRunSql("workspace_id = ?", "created_at ASC, run_id ASC")),
    listByWorkspacePagedStatement: db.connection.prepare(
      selectRunSql("workspace_id = ?", "created_at ASC, run_id ASC", "LIMIT ? OFFSET ?")
    ),
    countByWorkspaceStatement: db.connection.prepare(`
      SELECT COUNT(*) AS total
      FROM runs
      WHERE workspace_id = ?
    `),
    updateStateStatement: db.connection.prepare(`
      UPDATE runs
      SET run_state = ?, last_active_at = ?
      WHERE run_id = ?
    `),
    updateTitleStatement: db.connection.prepare(`
      UPDATE runs
      SET title = ?
      WHERE run_id = ?
    `)
  };
}

function selectRunSql(whereClause: string, orderBy?: string, suffix = ""): string {
  const orderBySql = orderBy === undefined ? "" : `\n      ORDER BY ${orderBy}`;
  const suffixSql = suffix.length === 0 ? "" : `\n      ${suffix}`;
  return `
      SELECT${RUN_SELECT_COLUMNS}
      FROM runs
      WHERE ${whereClause}${orderBySql}${suffixSql}
    `;
}

const RUN_SELECT_COLUMNS = `
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        engine_class,
        run_state,
        current_surface_id,
        created_at,
        last_active_at
`;

const CREATE_RUN_SQL = `
      INSERT INTO runs (
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        engine_class,
        run_state,
        current_surface_id,
        created_at,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
