import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface WorkerRunStatements {
  readonly insertStatement: SqliteStatement;
  readonly getByIdStatement: SqliteStatement;
  readonly deleteIfStateStatement: SqliteStatement;
  readonly updateStateStatement: SqliteStatement;
  readonly findActiveByPrincipalRunIdStatement: SqliteStatement;
  readonly countActiveByRequestingPrincipalStatement: SqliteStatement;
}

export function prepareWorkerRunStatements(db: StorageDatabase): WorkerRunStatements {
  return {
    insertStatement: db.connection.prepare(INSERT_WORKER_RUN_SQL),
    getByIdStatement: db.connection.prepare(selectWorkerRunSql("byId", "limitOne")),
    deleteIfStateStatement: db.connection.prepare(`
      DELETE FROM worker_runs
      WHERE worker_run_id = ? AND state = ?
    `),
    updateStateStatement: db.connection.prepare(`
      UPDATE worker_runs
      SET state = ?, updated_at = ?
      WHERE worker_run_id = ? AND state = ?
    `),
    findActiveByPrincipalRunIdStatement: db.connection.prepare(
      selectWorkerRunSql("activeByPrincipalRun", "limitOne", "created")
    ),
    countActiveByRequestingPrincipalStatement: db.connection.prepare(`
      SELECT COUNT(*) AS active_count
      FROM worker_runs
      WHERE requesting_principal_run_id = ?
        AND state IN ('init', 'active', 'suspended')
    `)
  };
}

type WorkerRunWhereKey = "byId" | "activeByPrincipalRun";
type WorkerRunSuffixKey = "limitOne";
type WorkerRunOrderKey = "created";

const WORKER_RUN_WHERE_CLAUSES: Readonly<Record<WorkerRunWhereKey, string>> = Object.freeze({
  byId: "worker_run_id = ?",
  activeByPrincipalRun: "principal_run_id = ? AND state = 'active'"
});

const WORKER_RUN_SUFFIXES: Readonly<Record<WorkerRunSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1"
});

const WORKER_RUN_ORDER_BY: Readonly<Record<WorkerRunOrderKey, string>> = Object.freeze({
  created: "created_at ASC"
});

function selectWorkerRunSql(
  whereKey: WorkerRunWhereKey,
  suffixKey: WorkerRunSuffixKey,
  orderByKey?: WorkerRunOrderKey
): string {
  const orderBySql = orderByKey === undefined ? "" : `\n      ORDER BY ${WORKER_RUN_ORDER_BY[orderByKey]}`;
  return `
      SELECT${WORKER_RUN_SELECT_COLUMNS}
      FROM worker_runs
      WHERE ${WORKER_RUN_WHERE_CLAUSES[whereKey]}${orderBySql}
      ${WORKER_RUN_SUFFIXES[suffixKey]}
    `;
}

const WORKER_RUN_SELECT_COLUMNS = `
        worker_run_id,
        principal_run_id,
        workspace_id,
        requesting_principal_run_id,
        requesting_worker_run_id,
        engine_class,
        state,
        subtask_description,
        local_surface_ref,
        local_evidence_pointer,
        restricted_tool_set_json,
        local_budget_json,
        agreed_return_format_json,
        principal_security_snapshot_json,
        created_at,
        updated_at
`;

const INSERT_WORKER_RUN_SQL = `
      INSERT INTO worker_runs (
        worker_run_id,
        principal_run_id,
        workspace_id,
        requesting_principal_run_id,
        requesting_worker_run_id,
        engine_class,
        state,
        subtask_description,
        local_surface_ref,
        local_evidence_pointer,
        restricted_tool_set_json,
        local_budget_json,
        agreed_return_format_json,
        principal_security_snapshot_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
