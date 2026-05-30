-- enrich_pending is the durable hand-off side table between the synchronous
-- write-path and the asynchronous Garden BULK_ENRICH worker. When a memory is
-- materialized the write-path enqueues one row here and acks; it runs no
-- conflict-detection / edge-auto-production inline. The BULK_ENRICH Librarian
-- task claims oldest unprocessed rows in batches and runs the governed
-- enrichment services for each, then marks the row processed. DB-backed so a
-- daemon restart never drops queued enrichment (the WSL2 in-memory-counter
-- lesson — OQ4).
--
-- claimed_at marks a row in-flight (claimed by a draining cycle) so a second
-- concurrent cycle never re-claims it; processed_at marks it done. A row is
-- claimable iff processed_at IS NULL AND claimed_at IS NULL. A claim stranded by
-- a crash between claim and markProcessed is re-armed to claimable by
-- reclaimStale (claimed_at IS NOT NULL AND processed_at IS NULL AND claimed_at <
-- cutoff) on the ~60s GardenScheduler pass, the same TTL-reclaim garden_task
-- has — so a daemon restart never permanently strands enrichment. The
-- UNIQUE(workspace_id, memory_id) PRIMARY KEY makes a re-enqueue of the same
-- memory an idempotent upsert (R3) — re-materialize cannot create a duplicate
-- pending row.
-- see also: packages/storage/src/repos/enrich-pending-repo.ts
-- see also: apps/core-daemon/src/garden-runtime.ts BULK_ENRICH drain worker
CREATE TABLE enrich_pending (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  memory_id       TEXT NOT NULL,
  run_id          TEXT,
  source_signal_id TEXT,
  enqueued_at     TEXT NOT NULL,
  claimed_at      TEXT,
  processed_at    TEXT,
  PRIMARY KEY (workspace_id, memory_id)
);

-- claimBatch / countPending scan oldest-unprocessed-first within a workspace;
-- this partial index keeps that ordered scan off the full table.
CREATE INDEX idx_enrich_pending_claimable
  ON enrich_pending(workspace_id, enqueued_at)
  WHERE processed_at IS NULL AND claimed_at IS NULL;
