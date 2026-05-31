import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

// invariant: durable hand-off queue between the synchronous write-path and the
// asynchronous Garden BULK_ENRICH worker. Materialization enqueues one row per
// new memory and acks; the worker claims oldest-unprocessed rows in batches,
// runs the governed enrichment services per memory, then marks them processed.
// DB-backed so a restart never drops queued enrichment (OQ4). enqueue is an
// idempotent upsert on (workspace_id, memory_id) so a re-materialize / re-enqueue
// of the same memory is a no-op (R3). The transient-retry seam is bounded: a
// repeated TRANSIENT failure increments attempt_count and, once it reaches the
// cap, dead-letters the marker (abandoned_at set, excluded from claims) so a
// never-clearing fault cannot starve the per-pass claim budget forever; the
// drain emits an auditable abandon event so the drop is never silent.
// see also: migrations/086-enrich-pending.sql — base schema
// see also: migrations/088-enrich-pending-attempt-bound.sql — attempt cap + dead-letter
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

/**
 * Outcome of recording a transient failure against a claimed marker. `abandoned`
 * is true once the failure pushed `attemptCount` to/over `maxAttempts`: the
 * marker was dead-lettered (abandoned_at set, excluded from future claims) rather
 * than released for retry, so the caller MUST emit the auditable abandon event.
 */
export interface EnrichPendingFailedAttemptResult {
  readonly attemptCount: number;
  readonly abandoned: boolean;
}

export interface EnrichPendingRepo {
  /** Idempotent upsert: re-enqueueing the same memory does not duplicate the row. */
  enqueue(input: EnrichPendingEnqueueInput): void;
  /**
   * Atomically claim up to `limit` oldest unprocessed+unclaimed rows for the
   * workspace. Dead-lettered markers (abandoned_at set) and markers already
   * at/over `maxAttempts` are excluded so an exhausted retry never re-consumes
   * the per-pass budget.
   */
  claimBatch(
    workspaceId: string,
    limit: number,
    claimedAt: string,
    maxAttempts: number
  ): readonly EnrichPendingClaim[];
  /** Mark a claimed memory processed (idempotent: a re-mark is a no-op). */
  markProcessed(workspaceId: string, memoryId: string, processedAt: string): void;
  /**
   * Record a TRANSIENT per-memory failure against a claimed marker. Increments
   * attempt_count, then either releases the claim back to claimable (under the
   * cap, so a later cycle retries) OR dead-letters the marker (at/over the cap:
   * abandoned_at set, excluded from future claims). Returns the new attempt
   * count and whether the marker was abandoned, so the caller emits the
   * auditable abandon event. A re-mark after markProcessed/abandon is a no-op.
   */
  recordFailedAttempt(
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ): EnrichPendingFailedAttemptResult;
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

interface AttemptRow {
  readonly attempt_count: number;
}

export class SqliteEnrichPendingRepo implements EnrichPendingRepo {
  private readonly enqueueStatement;
  private readonly selectClaimableStatement;
  private readonly claimStatement;
  private readonly markProcessedStatement;
  private readonly incrementAttemptStatement;
  private readonly selectAttemptStatement;
  private readonly releaseClaimStatement;
  private readonly abandonStatement;
  private readonly deleteStatement;
  private readonly countPendingStatement;
  private readonly reclaimStaleStatement;
  private readonly claimBatchTransaction: (
    workspaceId: string,
    limit: number,
    claimedAt: string,
    maxAttempts: number
  ) => readonly EnrichPendingClaim[];
  private readonly recordFailedAttemptTransaction: (
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ) => EnrichPendingFailedAttemptResult;

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

    // invariant: a dead-lettered marker (abandoned_at set) and a marker already
    // at/over the attempt cap are excluded so an exhausted retry never re-consumes
    // a slot of the per-pass claim budget — the bounded-liveness half of B4-R1.
    this.selectClaimableStatement = db.connection.prepare(`
      SELECT workspace_id, memory_id, run_id, source_signal_id, enqueued_at
      FROM enrich_pending
      WHERE workspace_id = ?
        AND processed_at IS NULL
        AND claimed_at IS NULL
        AND abandoned_at IS NULL
        AND attempt_count < ?
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

    // invariant: bump the transient-failure counter for a claimed, not-yet-settled
    // marker. The processed_at / abandoned_at guards keep a settled marker's count
    // frozen, so a re-mark after markProcessed or abandon is a no-op.
    this.incrementAttemptStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET attempt_count = attempt_count + 1
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
    `);

    this.selectAttemptStatement = db.connection.prepare(`
      SELECT attempt_count
      FROM enrich_pending
      WHERE workspace_id = ? AND memory_id = ?
    `);

    this.releaseClaimStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET claimed_at = NULL
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
    `);

    // invariant: terminal dead-letter — set abandoned_at so the claimable index
    // and selectClaimable exclude the marker permanently. Leaves claimed_at as-is
    // (the row is no longer claimable regardless) and never touches a marker that
    // already settled (processed_at set).
    this.abandonStatement = db.connection.prepare(`
      UPDATE enrich_pending
      SET abandoned_at = ?
      WHERE workspace_id = ? AND memory_id = ? AND processed_at IS NULL AND abandoned_at IS NULL
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
      WHERE claimed_at IS NOT NULL AND processed_at IS NULL AND abandoned_at IS NULL AND claimed_at < ?
    `);

    // invariant: select-then-claim in one transaction so two concurrent
    // BULK_ENRICH cycles can never claim the same row. The per-row UPDATE
    // re-checks claimed_at IS NULL, so even if the SELECT raced the row is
    // only handed out once (changes === 1).
    this.claimBatchTransaction = db.connection.transaction(
      (
        workspaceId: string,
        limit: number,
        claimedAt: string,
        maxAttempts: number
      ): readonly EnrichPendingClaim[] => {
        const candidates = this.selectClaimableStatement.all(
          workspaceId,
          maxAttempts,
          limit
        ) as ClaimRow[];
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

    // invariant: increment-then-branch in one transaction so the abandon decision
    // is taken against the just-incremented count with no interleaving claim.
    // Under the cap -> release for retry; at/over the cap -> dead-letter. The
    // attempt counter only advances for a TRANSIENT failure (this is the only
    // caller); a permanent rejection settles via markProcessed and never lands
    // here, and a re-mark after settle is a no-op (the UPDATE guards exclude it).
    this.recordFailedAttemptTransaction = db.connection.transaction(
      (
        workspaceId: string,
        memoryId: string,
        maxAttempts: number,
        abandonedAt: string
      ): EnrichPendingFailedAttemptResult => {
        this.incrementAttemptStatement.run(workspaceId, memoryId);
        const attemptRow = this.selectAttemptStatement.get(workspaceId, memoryId) as
          | AttemptRow
          | undefined;
        const attemptCount = attemptRow?.attempt_count ?? 0;
        if (attemptCount >= maxAttempts) {
          this.abandonStatement.run(abandonedAt, workspaceId, memoryId);
          return { attemptCount, abandoned: true };
        }
        this.releaseClaimStatement.run(workspaceId, memoryId);
        return { attemptCount, abandoned: false };
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
    claimedAt: string,
    maxAttempts: number
  ): readonly EnrichPendingClaim[] {
    if (limit <= 0) {
      return [];
    }
    try {
      return this.claimBatchTransaction(workspaceId, limit, claimedAt, maxAttempts);
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

  public recordFailedAttempt(
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ): EnrichPendingFailedAttemptResult {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Failed to validate enrich_pending.record_failed_attempt.max_attempts."
      );
    }
    try {
      return this.recordFailedAttemptTransaction(workspaceId, memoryId, maxAttempts, abandonedAt);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to record enrich_pending failed attempt.",
        error
      );
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
