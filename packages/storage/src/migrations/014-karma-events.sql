CREATE TABLE IF NOT EXISTS karma_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  CHECK (kind IN ('accept_gain', 'reject_penalty', 'reuse_gain', 'evidence_gain', 'supersede_penalty'))
);

CREATE INDEX IF NOT EXISTS idx_karma_events_object_id
  ON karma_events(object_id);

CREATE INDEX IF NOT EXISTS idx_karma_events_workspace_id
  ON karma_events(workspace_id);

CREATE INDEX IF NOT EXISTS idx_karma_events_created_at
  ON karma_events(created_at);
