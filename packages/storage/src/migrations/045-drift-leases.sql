CREATE TABLE drift_leases (
  lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  granted_to TEXT NOT NULL,
  drift_id TEXT,
  expires_at TEXT NOT NULL,
  granted_at TEXT NOT NULL
);

CREATE INDEX idx_drift_leases_workspace_expires ON drift_leases(workspace_id, expires_at);
CREATE INDEX idx_drift_leases_expires ON drift_leases(expires_at);
