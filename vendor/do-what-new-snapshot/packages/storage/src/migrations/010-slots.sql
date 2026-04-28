CREATE TABLE IF NOT EXISTS slots (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'slot',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL DEFAULT 'system',

  governance_subject     TEXT NOT NULL,
  claim_kind             TEXT NOT NULL,
  scope_class            TEXT NOT NULL,
  winner_claim_id        TEXT,
  incumbent_since        TEXT,
  flip_conditions        TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_unique_key ON slots(
  json_extract(governance_subject, '$.canonical_key'),
  claim_kind,
  scope_class,
  workspace_id
);

CREATE INDEX IF NOT EXISTS idx_slots_workspace ON slots(workspace_id);
CREATE INDEX IF NOT EXISTS idx_slots_winner ON slots(winner_claim_id) WHERE winner_claim_id IS NOT NULL;
