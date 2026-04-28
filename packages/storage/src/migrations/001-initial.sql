CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,
  default_engine_binding TEXT,
  workspace_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  title TEXT NOT NULL,
  goal TEXT,
  run_mode TEXT NOT NULL,
  engine_binding_id TEXT,
  run_state TEXT NOT NULL DEFAULT 'idle',
  current_surface_id TEXT,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

CREATE TABLE event_log (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  caused_by TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_event_log_run_id ON event_log(run_id);
CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);
CREATE INDEX idx_event_log_type ON event_log(event_type);
