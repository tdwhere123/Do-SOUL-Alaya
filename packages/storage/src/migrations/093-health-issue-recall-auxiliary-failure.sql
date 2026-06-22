-- Extends health_issue_groups.cause_kind CHECK with 'recall_auxiliary_failure'
-- so an unexpected recall auxiliary lookup failure can surface to the operator
-- inbox. SQLite cannot ALTER a CHECK in place, so rebuild via _next + copy.
CREATE TABLE IF NOT EXISTS health_issue_groups_next (
  group_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_kind TEXT NOT NULL,
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (
    'orphan_radar', 'green_revoked', 'evidence_failure', 'path_relation_failure',
    'recall_auxiliary_failure'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'blocking')),
  confidence REAL NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  suggested_actions_json TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN (
    'pending', 'resolved', 'suppressed'
  )),
  resolved_at TEXT,
  resolved_by TEXT,
  UNIQUE (workspace_id, target_object_id, cause_kind)
);

INSERT INTO health_issue_groups_next (
  group_id,
  workspace_id,
  target_object_id,
  target_object_kind,
  cause_kind,
  severity,
  confidence,
  first_seen_at,
  last_seen_at,
  count,
  suggested_actions_json,
  resolution_state,
  resolved_at,
  resolved_by
)
SELECT
  group_id,
  workspace_id,
  target_object_id,
  target_object_kind,
  cause_kind,
  severity,
  confidence,
  first_seen_at,
  last_seen_at,
  count,
  suggested_actions_json,
  resolution_state,
  resolved_at,
  resolved_by
FROM health_issue_groups;

DROP TABLE health_issue_groups;

ALTER TABLE health_issue_groups_next RENAME TO health_issue_groups;

CREATE INDEX IF NOT EXISTS idx_health_issue_groups_workspace_state
  ON health_issue_groups (workspace_id, resolution_state, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_health_issue_groups_target
  ON health_issue_groups (target_object_id);
