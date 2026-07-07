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
    getByIdStatement: db.connection.prepare(selectWorkspaceSql("byId", undefined, "limitOne")),
    listStatement: db.connection.prepare(selectWorkspaceSql(undefined, "created")),
    listPagedStatement: db.connection.prepare(
      selectWorkspaceSql(undefined, "created", "paged")
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

type WorkspaceWhereKey = "byId";
type WorkspaceOrderKey = "created";
type WorkspaceSuffixKey = "limitOne" | "paged";

const WORKSPACE_WHERE_CLAUSES: Readonly<Record<WorkspaceWhereKey, string>> = Object.freeze({
  byId: "workspace_id = ?"
});

const WORKSPACE_ORDER_BY: Readonly<Record<WorkspaceOrderKey, string>> = Object.freeze({
  created: "created_at ASC, workspace_id ASC"
});

const WORKSPACE_SUFFIXES: Readonly<Record<WorkspaceSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1",
  paged: "LIMIT ? OFFSET ?"
});

function selectWorkspaceSql(
  whereKey?: WorkspaceWhereKey,
  orderByKey?: WorkspaceOrderKey,
  suffixKey?: WorkspaceSuffixKey
): string {
  const whereSql = whereKey === undefined ? "" : `\n      WHERE ${WORKSPACE_WHERE_CLAUSES[whereKey]}`;
  const orderBySql = orderByKey === undefined ? "" : `\n      ORDER BY ${WORKSPACE_ORDER_BY[orderByKey]}`;
  const suffixSql = suffixKey === undefined ? "" : `\n      ${WORKSPACE_SUFFIXES[suffixKey]}`;
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
