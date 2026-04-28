CREATE TABLE engine_bindings (
  binding_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_engine_bindings_workspace_id ON engine_bindings(workspace_id);
