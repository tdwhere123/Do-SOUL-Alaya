import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { prepareEnrichPendingStatements } from "./enrich-pending-statements.js";
import {
  createClaimBatchTransaction,
  createRecordFailedAttemptTransaction
} from "./enrich-pending-transactions.js";

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
// see also: apps/core-daemon/src/garden/runtime.ts — drain worker
// see also: packages/soul/src/garden/materialization-router/router.ts — enqueue producer

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
   * see also: packages/storage/src/repos/garden/garden-task-repo.ts peekAbandonedClaims
   */
  reclaimStale(now: string, staleAfterMs: number): number;
}

interface CountRow {
  readonly pending: number;
}

export class SqliteEnrichPendingRepo implements EnrichPendingRepo {
  private readonly enqueueStatement;
  private readonly markProcessedStatement;
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
    const statements = prepareEnrichPendingStatements(db);
    this.enqueueStatement = statements.enqueueStatement;
    this.markProcessedStatement = statements.markProcessedStatement;
    this.deleteStatement = statements.deleteStatement;
    this.countPendingStatement = statements.countPendingStatement;
    this.reclaimStaleStatement = statements.reclaimStaleStatement;
    this.claimBatchTransaction = createClaimBatchTransaction(db, statements);
    this.recordFailedAttemptTransaction = createRecordFailedAttemptTransaction(db, statements);
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
