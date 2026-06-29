CREATE TABLE IF NOT EXISTS memory_hq (
  object_id TEXT PRIMARY KEY REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  hqs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_hq_workspace
  ON memory_hq (workspace_id);
