CREATE TABLE IF NOT EXISTS orphan_radar (
  radar_id TEXT NOT NULL PRIMARY KEY,
  target_memory_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  suspected_surface_gaps_json TEXT NOT NULL DEFAULT '[]',
  suggested_action TEXT NOT NULL CHECK(
    suggested_action IN ('re_anchor_candidate', 'archive_candidate', 'no_action')
  ),
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  detected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orphan_radar_workspace
  ON orphan_radar(workspace_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_orphan_radar_target
  ON orphan_radar(target_memory_id);
