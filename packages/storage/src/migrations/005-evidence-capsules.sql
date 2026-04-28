CREATE TABLE IF NOT EXISTS evidence_capsules (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'evidence_capsule',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  semantic_anchor TEXT NOT NULL,
  event_anchor TEXT,
  physical_anchor TEXT,
  evidence_health_state TEXT NOT NULL DEFAULT 'verified',
  gist TEXT NOT NULL,
  excerpt TEXT,
  source_hash TEXT,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  surface_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidence_capsules_run_id ON evidence_capsules(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_capsules_workspace_id ON evidence_capsules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_evidence_capsules_health ON evidence_capsules(evidence_health_state);
