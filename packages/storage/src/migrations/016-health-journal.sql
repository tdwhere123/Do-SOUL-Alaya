CREATE TABLE IF NOT EXISTS health_journal (
  entry_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_journal_workspace_created
  ON health_journal (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_journal_workspace_kind
  ON health_journal (workspace_id, event_kind, created_at DESC);
