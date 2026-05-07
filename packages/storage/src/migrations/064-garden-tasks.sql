CREATE TABLE IF NOT EXISTS garden_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_garden_tasks_status_role ON garden_tasks(status, role);
CREATE INDEX IF NOT EXISTS idx_garden_tasks_workspace ON garden_tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_garden_tasks_claimed_at ON garden_tasks(claimed_at) WHERE status = 'claimed';
