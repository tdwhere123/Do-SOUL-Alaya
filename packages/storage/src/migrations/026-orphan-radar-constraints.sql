-- Recreate orphan_radar with temporal CHECK constraint.
-- Missing from migration 018:
--   CHECK(expires_at > detected_at) to enforce temporal ordering
-- Multiple radar entries per (target_memory_id, workspace_id) are intentional:
--   the auditor accumulates history; deleteExpired() prunes old rows.
-- SQLite does not support ALTER TABLE ADD CONSTRAINT, so table recreation is required.

CREATE TABLE IF NOT EXISTS orphan_radar_v2 (
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
  requires_review INTEGER NOT NULL DEFAULT 0,
  CHECK(expires_at > detected_at),
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

-- Copy rows that satisfy the new temporal constraint.
INSERT INTO orphan_radar_v2
  SELECT
    radar_id,
    target_memory_id,
    workspace_id,
    suspected_surface_gaps_json,
    suggested_action,
    confidence,
    detected_at,
    expires_at,
    requires_review
  FROM orphan_radar
  WHERE expires_at > detected_at;

DROP TABLE orphan_radar;
ALTER TABLE orphan_radar_v2 RENAME TO orphan_radar;

CREATE INDEX IF NOT EXISTS idx_orphan_radar_workspace
  ON orphan_radar(workspace_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_orphan_radar_target
  ON orphan_radar(target_memory_id);
