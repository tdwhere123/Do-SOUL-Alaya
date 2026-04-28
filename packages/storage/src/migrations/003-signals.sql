CREATE TABLE signals (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT,
  source TEXT NOT NULL,
  signal_kind TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  scope_hint TEXT,
  domain_tags_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  signal_state TEXT NOT NULL DEFAULT 'emitted',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_signals_run_id ON signals(run_id);
CREATE INDEX idx_signals_workspace_id ON signals(workspace_id);
CREATE INDEX idx_signals_source ON signals(source);
CREATE INDEX idx_signals_kind ON signals(signal_kind);
