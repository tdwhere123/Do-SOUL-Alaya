import type { StorageDatabase } from "../../sqlite/db.js";
import type {
  EnrichPendingClaim,
  EnrichPendingFailedAttemptResult
} from "./enrich-pending-repo.js";
import type { EnrichPendingStatements } from "./enrich-pending-statements.js";

interface ClaimRow {
  readonly workspace_id: string;
  readonly memory_id: string;
  readonly run_id: string | null;
  readonly source_signal_id: string | null;
  readonly enqueued_at: string;
}

interface AttemptRow {
  readonly attempt_count: number;
}

export function createClaimBatchTransaction(
  db: StorageDatabase,
  statements: EnrichPendingStatements
): (
  workspaceId: string,
  limit: number,
  claimedAt: string,
  maxAttempts: number
) => readonly EnrichPendingClaim[] {
  return db.connection.transaction(
    (
      workspaceId: string,
      limit: number,
      claimedAt: string,
      maxAttempts: number
    ): readonly EnrichPendingClaim[] => {
      const candidates = statements.selectClaimableStatement.all(
        workspaceId,
        maxAttempts,
        limit
      ) as ClaimRow[];
      const claimed: EnrichPendingClaim[] = [];
      for (const row of candidates) {
        const result = statements.claimStatement.run(claimedAt, row.workspace_id, row.memory_id);
        if (result.changes === 1) {
          claimed.push({
            workspaceId: row.workspace_id,
            memoryId: row.memory_id,
            runId: row.run_id,
            sourceSignalId: row.source_signal_id,
            enqueuedAt: row.enqueued_at
          });
        }
      }
      return claimed;
    }
  );
}

export function createRecordFailedAttemptTransaction(
  db: StorageDatabase,
  statements: EnrichPendingStatements
): (
  workspaceId: string,
  memoryId: string,
  maxAttempts: number,
  abandonedAt: string
) => EnrichPendingFailedAttemptResult {
  return db.connection.transaction(
    (
      workspaceId: string,
      memoryId: string,
      maxAttempts: number,
      abandonedAt: string
    ): EnrichPendingFailedAttemptResult => {
      statements.incrementAttemptStatement.run(workspaceId, memoryId);
      const attemptRow = statements.selectAttemptStatement.get(workspaceId, memoryId) as
        | AttemptRow
        | undefined;
      const attemptCount = attemptRow?.attempt_count ?? 0;
      if (attemptCount >= maxAttempts) {
        statements.abandonStatement.run(abandonedAt, workspaceId, memoryId);
        return { attemptCount, abandoned: true };
      }
      statements.releaseClaimStatement.run(workspaceId, memoryId);
      return { attemptCount, abandoned: false };
    }
  );
}
