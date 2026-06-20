import type { StorageDatabase } from "../../sqlite/db.js";

interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };
type StatementMap<T extends object> = { -readonly [K in keyof T]: SqliteStatement };

export interface EnrichPendingStatements {
  readonly enqueueStatement: SqliteStatement;
  readonly selectClaimableStatement: SqliteStatement;
  readonly claimStatement: SqliteStatement;
  readonly markProcessedStatement: SqliteStatement;
  readonly incrementAttemptStatement: SqliteStatement;
  readonly selectAttemptStatement: SqliteStatement;
  readonly releaseClaimStatement: SqliteStatement;
  readonly abandonStatement: SqliteStatement;
  readonly deleteStatement: SqliteStatement;
  readonly countPendingStatement: SqliteStatement;
  readonly reclaimStaleStatement: SqliteStatement;
}

const ENRICH_PENDING_SQL: SqlDefinitionMap<EnrichPendingStatements> = {
  enqueueStatement: `
      INSERT INTO enrich_pending (
        workspace_id,
        memory_id,
        run_id,
        source_signal_id,
        enqueued_at,
        claimed_at,
        processed_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(workspace_id, memory_id) DO UPDATE SET
        run_id = excluded.run_id,
        source_signal_id = excluded.source_signal_id,
        claimed_at = NULL,
        processed_at = NULL
      WHERE enrich_pending.processed_at IS NOT NULL
    `,
  selectClaimableStatement: `
      SELECT workspace_id, memory_id, run_id, source_signal_id, enqueued_at
      FROM enrich_pending
      WHERE workspace_id = ?
        AND processed_at IS NULL
        AND claimed_at IS NULL
        AND abandoned_at IS NULL
        AND attempt_count < ?
      ORDER BY enqueued_at ASC, memory_id ASC
      LIMIT ?
    `,
  claimStatement: `
      UPDATE enrich_pending
      SET claimed_at = ?
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND claimed_at IS NULL
    `,
  markProcessedStatement: `
      UPDATE enrich_pending
      SET processed_at = ?
      WHERE workspace_id = ? AND memory_id = ?
    `,
  incrementAttemptStatement: `
      UPDATE enrich_pending
      SET attempt_count = attempt_count + 1
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
    `,
  selectAttemptStatement: `
      SELECT attempt_count
      FROM enrich_pending
      WHERE workspace_id = ? AND memory_id = ?
    `,
  releaseClaimStatement: `
      UPDATE enrich_pending
      SET claimed_at = NULL
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
    `,
  abandonStatement: `
      UPDATE enrich_pending
      SET abandoned_at = ?
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
    `,
  deleteStatement: `
      DELETE FROM enrich_pending
      WHERE workspace_id = ? AND memory_id = ?
    `,
  countPendingStatement: `
      SELECT COUNT(*) AS pending
      FROM enrich_pending
      WHERE workspace_id = ? AND processed_at IS NULL
    `,
  reclaimStaleStatement: `
      UPDATE enrich_pending
      SET claimed_at = NULL
      WHERE claimed_at IS NOT NULL AND processed_at IS NULL AND abandoned_at IS NULL AND claimed_at < ?
    `
};

export function prepareEnrichPendingStatements(db: StorageDatabase): EnrichPendingStatements {
  return prepareStatementGroup(db, ENRICH_PENDING_SQL);
}

function prepareStatementGroup<T extends object>(
  db: StorageDatabase,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
