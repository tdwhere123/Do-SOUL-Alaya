CREATE TABLE IF NOT EXISTS surface_identities (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_identity',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  surface_kind TEXT NOT NULL,
  surface_status TEXT NOT NULL DEFAULT 'active',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_identities_surface
  ON surface_identities(surface_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_identities_workspace
  ON surface_identities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_identities_status
  ON surface_identities(surface_status);

CREATE TABLE IF NOT EXISTS surface_anchors (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_anchor',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  anchor_value TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (surface_id, workspace_id)
    REFERENCES surface_identities(surface_id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_surface_anchors_surface
  ON surface_anchors(surface_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_anchors_workspace
  ON surface_anchors(workspace_id);
