-- Bounded FIFO review/re-drive queue for garden source-grounding deferrals.
-- Governance metadata only: never creates durable memory (invariant §14).
-- Cap is enforced in the repo layer (SOURCE_GROUNDING_DEFER_QUEUE_CAP), not SQL.
-- Lifetime reason counters live in source_grounding_defer_reason_counts so
-- histogram survives FIFO eviction / successful re-drive dequeue.
-- see also: packages/storage/src/repos/garden/source-grounding-defer-queue-repo.ts
-- see also: packages/core/src/memory/source-grounding-defer-queue.ts

CREATE TABLE IF NOT EXISTS source_grounding_defer_queue (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  defer_reason TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_grounding_defer_queue_enqueued
  ON source_grounding_defer_queue(enqueued_at, signal_id);

CREATE TABLE IF NOT EXISTS source_grounding_defer_reason_counts (
  defer_reason TEXT PRIMARY KEY,
  enqueue_count INTEGER NOT NULL CHECK(enqueue_count >= 0)
);
