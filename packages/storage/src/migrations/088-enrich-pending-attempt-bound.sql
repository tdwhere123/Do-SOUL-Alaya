-- enrich_pending is an unbounded transient-retry queue: a claimed row that fails
-- transiently releases its claim, reclaimStale re-arms a crash-stranded claim,
-- and the row is re-claimed every drain pass. That is correct for a fault that
-- eventually clears, but a fault that never clears (a permanent fault
-- mis-classified as transient, or a stuck input) sits at the oldest-first front
-- of the queue and is re-claimed every pass forever, consuming one of the
-- workspace's claim_batch_size budget per pass and starving healthy markers
-- behind it. attempt_count bounds the retries; abandoned_at dead-letters a
-- marker that exhausted them. A dead-lettered marker is excluded from claims and
-- never re-served, freeing the per-pass budget; the drain emits an auditable
-- SOUL_ENRICH_ABANDONED event so the drop is never silent.
-- see also: packages/storage/src/repos/enrich-pending-repo.ts
-- see also: apps/core-daemon/src/garden-runtime.ts BULK_ENRICH drain worker
-- see also: packages/protocol/src/soul/dynamics-constants.ts enrich.max_attempts
ALTER TABLE enrich_pending ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrich_pending ADD COLUMN abandoned_at TEXT;

-- The claimable partial index must also exclude dead-lettered rows so the
-- oldest-first claim scan never re-serves an abandoned marker. Recreate it with
-- abandoned_at IS NULL added to the partial predicate.
DROP INDEX IF EXISTS idx_enrich_pending_claimable;
CREATE INDEX idx_enrich_pending_claimable
  ON enrich_pending(workspace_id, enqueued_at)
  WHERE processed_at IS NULL AND claimed_at IS NULL AND abandoned_at IS NULL;
