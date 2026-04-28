CREATE TABLE IF NOT EXISTS project_mapping_anchors (
  object_id            TEXT PRIMARY KEY,
  object_kind          TEXT NOT NULL DEFAULT 'project_mapping_anchor',
  schema_version       INTEGER NOT NULL DEFAULT 1,
  lifecycle_state      TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL DEFAULT 'system',

  global_object_id     TEXT NOT NULL,
  project_id           TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  mapping_state        TEXT NOT NULL DEFAULT 'suggested',
  accepted_by          TEXT,
  last_transition_at   TEXT NOT NULL,

  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_unique
ON project_mapping_anchors (global_object_id, workspace_id);

CREATE INDEX IF NOT EXISTS idx_pma_workspace
ON project_mapping_anchors (workspace_id);

CREATE INDEX IF NOT EXISTS idx_pma_global_obj
ON project_mapping_anchors (global_object_id, workspace_id);

CREATE INDEX IF NOT EXISTS idx_pma_state
ON project_mapping_anchors (mapping_state);
