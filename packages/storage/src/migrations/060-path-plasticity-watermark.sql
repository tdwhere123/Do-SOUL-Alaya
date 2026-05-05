CREATE TABLE IF NOT EXISTS path_plasticity_watermark (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  last_processed_reported_at TEXT NOT NULL,
  last_processed_audit_event_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_path_plasticity_watermark_updated
  ON path_plasticity_watermark(updated_at);

INSERT OR IGNORE INTO path_plasticity_watermark (
  workspace_id,
  last_processed_reported_at,
  last_processed_audit_event_id,
  updated_at
)
SELECT
  workspaces.workspace_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours'),
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces
GROUP BY workspaces.workspace_id;
