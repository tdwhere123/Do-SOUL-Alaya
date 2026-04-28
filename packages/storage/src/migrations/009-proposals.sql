CREATE TABLE IF NOT EXISTS proposals (
  runtime_id               TEXT PRIMARY KEY,
  object_kind              TEXT NOT NULL DEFAULT 'proposal',
  proposal_id              TEXT NOT NULL UNIQUE,
  task_surface_ref         TEXT,
  derived_from             TEXT,
  retention_policy         TEXT NOT NULL DEFAULT 'session_only',
  dossier_ref              TEXT,
  recommended_option_id    TEXT,
  proposal_options         TEXT NOT NULL DEFAULT '[]',
  resolution_state         TEXT NOT NULL DEFAULT 'pending',
  expires_at               TEXT,
  last_updated_at          TEXT NOT NULL,

  workspace_id             TEXT NOT NULL,
  run_id                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_workspace_id ON proposals(workspace_id);
CREATE INDEX IF NOT EXISTS idx_proposals_resolution_state ON proposals(resolution_state);
CREATE INDEX IF NOT EXISTS idx_proposals_proposal_id ON proposals(proposal_id);
