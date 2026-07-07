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
    getByIdStatement: db.connection.prepare(selectRunSql("byId", undefined, "limitOne")),
    listByWorkspaceStatement: db.connection.prepare(selectRunSql("byWorkspace", "created")),
    listByWorkspacePagedStatement: db.connection.prepare(
      selectRunSql("byWorkspace", "created", "paged")
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

type RunWhereKey = "byId" | "byWorkspace";
type RunOrderKey = "created";
type RunSuffixKey = "limitOne" | "paged";

const RUN_WHERE_CLAUSES: Readonly<Record<RunWhereKey, string>> = Object.freeze({
  byId: "run_id = ?",
  byWorkspace: "workspace_id = ?"
});

const RUN_ORDER_BY: Readonly<Record<RunOrderKey, string>> = Object.freeze({
  created: "created_at ASC, run_id ASC"
});

const RUN_SUFFIXES: Readonly<Record<RunSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1",
  paged: "LIMIT ? OFFSET ?"
});

function selectRunSql(whereKey: RunWhereKey, orderByKey?: RunOrderKey, suffixKey?: RunSuffixKey): string {
  const orderBySql = orderByKey === undefined ? "" : `\n      ORDER BY ${RUN_ORDER_BY[orderByKey]}`;
  const suffixSql = suffixKey === undefined ? "" : `\n      ${RUN_SUFFIXES[suffixKey]}`;
  return `
      SELECT${RUN_SELECT_COLUMNS}
      FROM runs
      WHERE ${RUN_WHERE_CLAUSES[whereKey]}${orderBySql}${suffixSql}
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
