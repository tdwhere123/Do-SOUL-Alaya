-- Rebuild strong_refs with compound-key identity:
-- UNIQUE includes workspace_id; target index covers (workspace_id, target_entity_type, target_entity_id).

CREATE TABLE IF NOT EXISTS strong_refs_new (
  ref_id TEXT PRIMARY KEY,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('governance_lease', 'security_snapshot', 'active_projection')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, source_entity_id, target_entity_id, reason)
);

INSERT INTO strong_refs_new
  SELECT ref_id, source_entity_type, source_entity_id, target_entity_type,
         target_entity_id, workspace_id, reason, created_at
  FROM strong_refs;

DROP TABLE strong_refs;
ALTER TABLE strong_refs_new RENAME TO strong_refs;

CREATE INDEX IF NOT EXISTS idx_strong_refs_target_compound
  ON strong_refs (workspace_id, target_entity_type, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_strong_refs_workspace_id
  ON strong_refs (workspace_id);
