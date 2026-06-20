import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface WorkspaceStatements {
  readonly createStatement: SqliteStatement;
  readonly getByIdStatement: SqliteStatement;
  readonly listStatement: SqliteStatement;
  readonly listPagedStatement: SqliteStatement;
  readonly countStatement: SqliteStatement;
  readonly updateRepoPathStatement: SqliteStatement;
  readonly updateDefaultEngineBindingStatement: SqliteStatement;
  readonly updateDefaultEngineClassStatement: SqliteStatement;
}

export function prepareWorkspaceStatements(db: StorageDatabase): WorkspaceStatements {
  return {
    createStatement: db.connection.prepare(CREATE_WORKSPACE_SQL),
    getByIdStatement: db.connection.prepare(selectWorkspaceSql("workspace_id = ?", undefined, "LIMIT 1")),
    listStatement: db.connection.prepare(selectWorkspaceSql(undefined, "created_at ASC, workspace_id ASC")),
    listPagedStatement: db.connection.prepare(
      selectWorkspaceSql(undefined, "created_at ASC, workspace_id ASC", "LIMIT ? OFFSET ?")
    ),
    countStatement: db.connection.prepare(`
      SELECT COUNT(*) AS total
      FROM workspaces
    `),
    updateRepoPathStatement: db.connection.prepare(updateWorkspaceColumnSql("repo_path")),
    updateDefaultEngineBindingStatement: db.connection.prepare(updateWorkspaceColumnSql("default_engine_binding")),
    updateDefaultEngineClassStatement: db.connection.prepare(updateWorkspaceColumnSql("default_engine_class"))
  };
}

function selectWorkspaceSql(whereClause?: string, orderBy?: string, suffix = ""): string {
  const whereSql = whereClause === undefined ? "" : `\n      WHERE ${whereClause}`;
  const orderBySql = orderBy === undefined ? "" : `\n      ORDER BY ${orderBy}`;
  const suffixSql = suffix.length === 0 ? "" : `\n      ${suffix}`;
  return `
      SELECT${WORKSPACE_SELECT_COLUMNS}
      FROM workspaces${whereSql}${orderBySql}${suffixSql}
    `;
}

function updateWorkspaceColumnSql(columnName: "repo_path" | "default_engine_binding" | "default_engine_class"): string {
  return `
      UPDATE workspaces
      SET ${columnName} = ?
      WHERE workspace_id = ?
    `;
}

const WORKSPACE_SELECT_COLUMNS = `
        workspace_id,
        name,
        root_path,
        workspace_kind,
        repo_path,
        default_engine_binding,
        default_engine_class,
        workspace_state,
        created_at,
        archived_at
`;

const CREATE_WORKSPACE_SQL = `
      INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        repo_path,
        default_engine_binding,
        default_engine_class,
        workspace_state,
        created_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
