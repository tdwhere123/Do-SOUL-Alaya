import type { SqliteConnection } from "../../sqlite/db.js";

export interface GardenTaskSqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };
type StatementMap<T extends object> = { -readonly [K in keyof T]: GardenTaskSqliteStatement };

export interface GardenTaskQueueStatements {
  readonly enqueueStatement: GardenTaskSqliteStatement;
  readonly findByIdStatement: GardenTaskSqliteStatement;
  readonly peekPendingStatement: GardenTaskSqliteStatement;
  readonly peekPendingByWorkspaceStatement: GardenTaskSqliteStatement;
}

export interface GardenTaskClaimStatements {
  readonly claimStatement: GardenTaskSqliteStatement;
  readonly failPendingStatement: GardenTaskSqliteStatement;
  readonly releaseClaimStatement: GardenTaskSqliteStatement;
  readonly beginCompletionAttemptStatement: GardenTaskSqliteStatement;
  readonly refreshClaimStatement: GardenTaskSqliteStatement;
  readonly completeStatement: GardenTaskSqliteStatement;
}

export interface GardenTaskMaintenanceStatements {
  readonly peekAbandonedClaimsStatement: GardenTaskSqliteStatement;
  readonly gcAbandonedClaimStatement: GardenTaskSqliteStatement;
  readonly peekExpiredUnclaimedStatement: GardenTaskSqliteStatement;
  readonly expireUnclaimedStatement: GardenTaskSqliteStatement;
}

export interface GardenTaskCountStatements {
  readonly countByRoleStatusStatement: GardenTaskSqliteStatement;
  readonly countByKindStatement: GardenTaskSqliteStatement;
  readonly countByKindByWorkspaceStatement: GardenTaskSqliteStatement;
}

const GARDEN_TASK_SELECT_COLUMNS = `
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
`;

const PENDING_ROLE_PRIORITY_FILTER_SQL = `
        AND CASE role
          WHEN 'janitor' THEN 0
          WHEN 'auditor' THEN 1
          WHEN 'librarian' THEN 2
          ELSE 99
        END <= ?
`;

const PENDING_PRIORITY_ORDER_SQL = `
      ORDER BY
        COALESCE(CAST(json_extract(payload_json, '$.priority') AS INTEGER), 0) DESC,
        created_at ASC,
        id ASC
`;

const GARDEN_TASK_QUEUE_SQL: SqlDefinitionMap<GardenTaskQueueStatements> = {
  enqueueStatement: `
      INSERT INTO garden_tasks (
        id,
        workspace_id,
        role,
        kind,
        payload_json,
        status,
        claimed_by,
        claimed_at,
        created_at,
        completed_at,
        attempt_count,
        last_error_text,
        completion_envelope_json
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, 0, NULL, NULL)
    `,
  findByIdStatement: `
      SELECT${GARDEN_TASK_SELECT_COLUMNS}
      FROM garden_tasks
      WHERE id = ?
      LIMIT 1
    `,
  peekPendingStatement: `
      SELECT${GARDEN_TASK_SELECT_COLUMNS}
      FROM garden_tasks
      WHERE status = 'pending'
${PENDING_ROLE_PRIORITY_FILTER_SQL}${PENDING_PRIORITY_ORDER_SQL}      LIMIT ?
    `,
  peekPendingByWorkspaceStatement: `
      SELECT${GARDEN_TASK_SELECT_COLUMNS}
      FROM garden_tasks
      WHERE status = 'pending'
${PENDING_ROLE_PRIORITY_FILTER_SQL}        AND workspace_id = ?
${PENDING_PRIORITY_ORDER_SQL}      LIMIT ?
    `
};

const GARDEN_TASK_CLAIM_SQL: SqlDefinitionMap<GardenTaskClaimStatements> = {
  claimStatement: `
      UPDATE garden_tasks
      SET status = 'claimed',
          claimed_by = ?,
          claimed_at = ?,
          attempt_count = attempt_count + 1
      WHERE id = ? AND status = 'pending' AND (? IS NULL OR workspace_id = ?)
    `,
  failPendingStatement: `
      UPDATE garden_tasks
      SET status = 'failed',
          claimed_by = NULL,
          claimed_at = NULL,
          completed_at = ?,
          last_error_text = ?
      WHERE id = ? AND status = 'pending'
    `,
  releaseClaimStatement: `
      UPDATE garden_tasks
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `,
  beginCompletionAttemptStatement: `
      UPDATE garden_tasks
      SET claimed_by = ?,
          claimed_at = ?,
          completion_envelope_json = COALESCE(completion_envelope_json, ?)
      WHERE id = ?
        AND status = 'claimed'
        AND claimed_by = ?
        AND (completion_envelope_json IS NULL OR completion_envelope_json = ?)
    `,
  refreshClaimStatement: `
      UPDATE garden_tasks
      SET claimed_at = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `,
  completeStatement: `
      UPDATE garden_tasks
      SET status = ?, completed_at = ?, last_error_text = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ?
    `
};

const GARDEN_TASK_MAINTENANCE_SQL: SqlDefinitionMap<GardenTaskMaintenanceStatements> = {
  peekAbandonedClaimsStatement: `
      SELECT${GARDEN_TASK_SELECT_COLUMNS}
      FROM garden_tasks
      WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?
      ORDER BY claimed_at ASC, id ASC
    `,
  gcAbandonedClaimStatement: `
      UPDATE garden_tasks
      SET status = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND claimed_at = ?
    `,
  peekExpiredUnclaimedStatement: `
      SELECT${GARDEN_TASK_SELECT_COLUMNS}
      FROM garden_tasks
      WHERE status = 'pending' AND kind = ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
  expireUnclaimedStatement: `
      DELETE FROM garden_tasks
      WHERE id = ? AND status = 'pending'
    `
};

const GARDEN_TASK_COUNT_SQL: SqlDefinitionMap<GardenTaskCountStatements> = {
  countByRoleStatusStatement: `
      SELECT role, status, COUNT(*) AS count
      FROM garden_tasks
      WHERE status IN ('pending', 'claimed')
        AND (? IS NULL OR workspace_id = ?)
      GROUP BY role, status
      ORDER BY role ASC, status ASC
    `,
  countByKindStatement: `
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? THEN 1 ELSE 0 END) AS stale
      FROM garden_tasks
      WHERE kind = ?
    `,
  countByKindByWorkspaceStatement: `
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ? THEN 1 ELSE 0 END) AS stale
      FROM garden_tasks
      WHERE kind = ? AND workspace_id = ?
    `
};

export function prepareGardenTaskQueueStatements(
  connection: SqliteConnection
): GardenTaskQueueStatements {
  return prepareStatementGroup(connection, GARDEN_TASK_QUEUE_SQL);
}

export function prepareGardenTaskClaimStatements(
  connection: SqliteConnection
): GardenTaskClaimStatements {
  return prepareStatementGroup(connection, GARDEN_TASK_CLAIM_SQL);
}

export function prepareGardenTaskMaintenanceStatements(
  connection: SqliteConnection
): GardenTaskMaintenanceStatements {
  return prepareStatementGroup(connection, GARDEN_TASK_MAINTENANCE_SQL);
}

export function prepareGardenTaskCountStatements(
  connection: SqliteConnection
): GardenTaskCountStatements {
  return prepareStatementGroup(connection, GARDEN_TASK_COUNT_SQL);
}

function prepareStatementGroup<T extends object>(
  connection: SqliteConnection,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
