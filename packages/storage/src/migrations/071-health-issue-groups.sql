-- HealthIssueGroup is the control-plane projection that aggregates raw
-- OrphanRadar, GreenStatus revoke, and evidence_failure signals by target
-- object plus cause_kind so operator inboxes can dedupe actions without
-- polluting memory ontology.

CREATE TABLE IF NOT EXISTS health_issue_groups (
  group_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_kind TEXT NOT NULL,
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (
    'orphan_radar', 'green_revoked', 'evidence_failure'
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

CREATE INDEX IF NOT EXISTS idx_health_issue_groups_workspace_state
  ON health_issue_groups (workspace_id, resolution_state, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_health_issue_groups_target
  ON health_issue_groups (target_object_id);
