CREATE TABLE IF NOT EXISTS surface_bindings (
  binding_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_binding',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  object_id TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  binding_state TEXT NOT NULL DEFAULT 'active',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (surface_id, workspace_id) REFERENCES surface_identities(surface_id, workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_bindings_primary
  ON surface_bindings(object_id, workspace_id) WHERE is_primary = 1 AND binding_state != 'detached';
CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_bindings_object_surface
  ON surface_bindings(object_id, surface_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_bindings_object
  ON surface_bindings(object_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_bindings_surface
  ON surface_bindings(surface_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_surface_bindings_workspace
  ON surface_bindings(workspace_id);

CREATE TABLE IF NOT EXISTS cross_cutting_permissions (
  permission_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'cross_cutting_permission',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  object_id TEXT NOT NULL,
  cross_cutting_state TEXT NOT NULL DEFAULT 'none',
  allowed_surfaces TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_cutting_object
  ON cross_cutting_permissions(object_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_cross_cutting_workspace
  ON cross_cutting_permissions(workspace_id);
