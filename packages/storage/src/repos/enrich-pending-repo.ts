import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

// invariant: durable hand-off queue between the synchronous write-path and the
// asynchronous Garden BULK_ENRICH worker. Materialization enqueues one row per
// new memory and acks; the worker claims oldest-unprocessed rows in batches,
// runs the governed enrichment services per memory, then marks them processed.
// DB-backed so a restart never drops queued enrichment (OQ4). enqueue is an
// idempotent upsert on (workspace_id, memory_id) so a re-materialize / re-enqueue
// of the same memory is a no-op (R3).
// see also: migrations/086-enrich-pending.sql — schema
// see also: apps/core-daemon/src/garden-runtime.ts — drain worker
// see also: packages/soul/src/garden/materialization-router.ts — enqueue producer

export interface EnrichPendingEnqueueInput {
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly runId: string | null;
  readonly sourceSignalId: string | null;
  readonly enqueuedAt: string;
}

export interface EnrichPendingClaim {
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly runId: string | null;
  readonly sourceSignalId: string | null;
  readonly enqueuedAt: string;
}

export interface EnrichPendingRepo {
  /** Idempotent upsert: re-enqueueing the same memory does not duplicate the row. */
  enqueue(input: EnrichPendingEnqueueInput): void;
  /** Atomically claim up to `limit` oldest unprocessed+unclaimed rows for the workspace. */
  claimBatch(workspaceId: string, limit: number, claimedAt: string): readonly EnrichPendingClaim[];
  /** Mark a claimed memory processed (idempotent: a re-mark is a no-op). */
  markProcessed(workspaceId: string, memoryId: string, processedAt: string): void;
  /**
   * Release a claim back to claimable (claimed_at = NULL) without marking it
   * processed, so a later cycle retries it. Used when a per-memory enrichment
   * attempt fails transiently — the marker must not be silently dropped.
   */
  releaseClaim(workspaceId: string, memoryId: string): void;
  /** Delete a row outright (used to drop a row whose memory no longer exists). */
  delete(workspaceId: string, memoryId: string): void;
  /** Count rows still awaiting processing (unprocessed, ignoring claim state). */
  countPending(workspaceId: string): number;
  /**
   * invariant: re-arm claimed-but-unprocessed rows whose claim is older than the
   * TTL (claimed_at < now - staleAfterMs) back to claimable (claimed_at = NULL),
   * so a claim stranded by a crash between claimBatch and markProcessed is
   * re-drained, not dropped. Returns rows reclaimed.
   * see also: packages/storage/src/repos/garden-task-repo.ts peekAbandonedClaims
   */
  reclaimStale(now: string, staleAfterMs: number): number;
}

interface ClaimRow {
  readonly workspace_id: string;
  readonly memory_id: string;
  readonly run_id: string | null;
  readonly source_signal_id: string | null;
  readonly enqueued_at: string;
}

interface CountRow {
  readonly pending: number;
}

export class SqliteEnrichPendingRepo implements EnrichPendingRepo {
  private readonly enqueueStatement;
  private readonly selectClaimableStatement;
  private readonly claimStatement;
  private readonly markProcessedStatement;
  private readonly releaseClaimStatement;
  private readonly deleteStatement;
  private readonly countPendingStatement;
  private readonly reclaimStaleStatement;
  private readonly claimBatchTransaction: (
    workspaceId: string,
    limit: number,
    claimedAt: string
  ) => readonly EnrichPendingClaim[];

  public constructor(db: StorageDatabase) {
    // ON CONFLICT keeps the original enqueued_at and clears any prior claim /
    // processed marker so a memory re-materialized after a processed cycle is
    // re-enriched. A still-pending duplicate is left untouched (no churn).
    this.enqueueStatement = db.connection.prepare(`
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
    `);

    this.selectClaimableStatement = db.connection.prepare(`
      SELECT workspace_id, memory_id, run_id, source_signal_id, enqueued_at
      FROM enrich_pending
      WHERE workspace_id = ? AND processed_at IS NULL AND claimed_at IS NULL
      ORDER BY enqueued_at ASC, memory_id ASC
      LIMIT ?
    `);

    this.claimStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET claimed_at = ?
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND claimed_at IS NULL
    `);

    this.markProcessedStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET processed_at = ?
      WHERE workspace_id = ? AND memory_id = ?
    `);

    this.releaseClaimStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET claimed_at = NULL
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM enrich_pending
      WHERE workspace_id = ? AND memory_id = ?
    `);

    this.countPendingStatement = db.connection.prepare(`
      SELECT COUNT(*) AS pending
      FROM enrich_pending
      WHERE workspace_id = ? AND processed_at IS NULL
    `);

    // invariant: workspace-agnostic crash-recovery sweep — a claim stranded by a
    // crash between claimBatch and markProcessed has no live claimant (the single
    // in-process worker died), so once it is older than the TTL it is re-armed
    // regardless of workspace. Mirrors garden-task-repo's stale-claim UPDATE.
    this.reclaimStaleStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET claimed_at = NULL
      WHERE claimed_at IS NOT NULL AND processed_at IS NULL AND claimed_at < ?
    `);

    // invariant: select-then-claim in one transaction so two concurrent
    // BULK_ENRICH cycles can never claim the same row. The per-row UPDATE
    // re-checks claimed_at IS NULL, so even if the SELECT raced the row is
    // only handed out once (changes === 1).
    this.claimBatchTransaction = db.connection.transaction(
      (workspaceId: string, limit: number, claimedAt: string): readonly EnrichPendingClaim[] => {
        const candidates = this.selectClaimableStatement.all(workspaceId, limit) as ClaimRow[];
        const claimed: EnrichPendingClaim[] = [];
        for (const row of candidates) {
          const result = this.claimStatement.run(claimedAt, row.workspace_id, row.memory_id);
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

  public enqueue(input: EnrichPendingEnqueueInput): void {
    try {
      this.enqueueStatement.run(
        input.workspaceId,
        input.memoryId,
        input.runId,
        input.sourceSignalId,
        input.enqueuedAt
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to enqueue enrich_pending row.", error);
    }
  }

  public claimBatch(
    workspaceId: string,
    limit: number,
    claimedAt: string
  ): readonly EnrichPendingClaim[] {
    if (limit <= 0) {
      return [];
    }
    try {
      return this.claimBatchTransaction(workspaceId, limit, claimedAt);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to claim enrich_pending batch.", error);
    }
  }

  public markProcessed(workspaceId: string, memoryId: string, processedAt: string): void {
    try {
      this.markProcessedStatement.run(processedAt, workspaceId, memoryId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to mark enrich_pending row processed.", error);
    }
  }

  public releaseClaim(workspaceId: string, memoryId: string): void {
    try {
      this.releaseClaimStatement.run(workspaceId, memoryId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to release enrich_pending claim.", error);
    }
  }

  public delete(workspaceId: string, memoryId: string): void {
    try {
      this.deleteStatement.run(workspaceId, memoryId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete enrich_pending row.", error);
    }
  }

  public countPending(workspaceId: string): number {
    try {
      const row = this.countPendingStatement.get(workspaceId) as CountRow | undefined;
      return row?.pending ?? 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count pending enrich_pending rows.", error);
    }
  }

  public reclaimStale(now: string, staleAfterMs: number): number {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      throw new StorageError("VALIDATION_FAILED", "Failed to validate enrich_pending.reclaim.now.");
    }
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Failed to validate enrich_pending.reclaim.stale_after_ms."
      );
    }
    const cutoff = new Date(nowMs - staleAfterMs).toISOString();
    try {
      const result = this.reclaimStaleStatement.run(cutoff);
      return result.changes;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to reclaim stale enrich_pending claims.", error);
    }
  }
}
