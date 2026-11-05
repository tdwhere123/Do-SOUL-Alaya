-- A backfill's committed memory IDs and its supported formation work survive
-- interruption independently of the parent task's completion event.
CREATE TABLE garden_embedding_backfill_runs (
  task_id TEXT PRIMARY KEY REFERENCES garden_tasks(id),
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('backfilling', 'pending', 'completed', 'skipped', 'blocked')),
  mode TEXT NOT NULL CHECK (mode IN ('production', 'cache_only', 'unwired')),
  owner_token TEXT,
  plan_digest TEXT,
  backfill_outcome TEXT CHECK (backfill_outcome IS NULL OR backfill_outcome IN ('completed', 'failed', 'skipped')),
  backfill_error TEXT,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE garden_embedding_backfill_objects (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES garden_embedding_backfill_runs(task_id),
  object_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (task_id, object_id)
);

CREATE INDEX garden_embedding_backfill_pending
  ON garden_embedding_backfill_runs (state, owner_token, workspace_id, task_id);
