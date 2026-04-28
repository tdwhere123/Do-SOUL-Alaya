CREATE TABLE IF NOT EXISTS claim_forms (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'claim_form',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  governance_subject     TEXT NOT NULL,
  claim_kind             TEXT NOT NULL,
  scope_class            TEXT NOT NULL,
  enforcement_level      TEXT NOT NULL,
  origin_tier            TEXT NOT NULL,
  precedence_basis       TEXT NOT NULL,
  proposition_digest     TEXT NOT NULL,
  evidence_refs          TEXT NOT NULL DEFAULT '[]',
  source_object_refs     TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  claim_status           TEXT NOT NULL DEFAULT 'draft'
);

CREATE INDEX IF NOT EXISTS idx_claim_forms_workspace_id ON claim_forms(workspace_id);
CREATE INDEX IF NOT EXISTS idx_claim_forms_claim_status ON claim_forms(claim_status);
CREATE INDEX IF NOT EXISTS idx_claim_forms_claim_kind ON claim_forms(claim_kind);
CREATE INDEX IF NOT EXISTS idx_claim_forms_governance_subject
  ON claim_forms(json_extract(governance_subject, '$.canonical_key'));
