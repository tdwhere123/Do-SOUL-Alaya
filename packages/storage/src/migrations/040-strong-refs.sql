CREATE TABLE IF NOT EXISTS strong_refs (
  ref_id TEXT PRIMARY KEY,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('governance_lease', 'security_snapshot', 'active_projection')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  UNIQUE (source_entity_id, target_entity_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_strong_refs_target_entity_id
  ON strong_refs (target_entity_id);

CREATE INDEX IF NOT EXISTS idx_strong_refs_workspace_id
  ON strong_refs (workspace_id);
