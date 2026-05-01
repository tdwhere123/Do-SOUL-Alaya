-- EventLog orphan reconciler support.
--
-- Existing orphan_radar rows target memory_entries through target_memory_id.
-- EventLog orphan rows target an audit event instead, so the table is rebuilt
-- with mutually exclusive memory/event targets while preserving the existing
-- memory FK and query indexes.
CREATE TABLE IF NOT EXISTS orphan_radar_v3 (
  radar_id TEXT NOT NULL PRIMARY KEY,
  target_memory_id TEXT,
  target_event_id TEXT,
  target_event_type TEXT,
  expected_table TEXT CHECK(expected_table IN ('trust_context_delivery', 'trust_usage_proof')),
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
  CHECK(
    (
      target_memory_id IS NOT NULL
      AND target_event_id IS NULL
      AND target_event_type IS NULL
      AND expected_table IS NULL
    )
    OR (
      target_memory_id IS NULL
      AND target_event_id IS NOT NULL
      AND target_event_type IS NOT NULL
      AND expected_table IS NOT NULL
    )
  ),
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

INSERT INTO orphan_radar_v3 (
  radar_id,
  target_memory_id,
  target_event_id,
  target_event_type,
  expected_table,
  workspace_id,
  suspected_surface_gaps_json,
  suggested_action,
  confidence,
  detected_at,
  expires_at,
  requires_review
)
SELECT
  radar_id,
  target_memory_id,
  NULL,
  NULL,
  NULL,
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
ALTER TABLE orphan_radar_v3 RENAME TO orphan_radar;

CREATE INDEX IF NOT EXISTS idx_orphan_radar_workspace
  ON orphan_radar(workspace_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_orphan_radar_target
  ON orphan_radar(target_memory_id)
  WHERE target_memory_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orphan_radar_target_event
  ON orphan_radar(target_event_id)
  WHERE target_event_id IS NOT NULL;
