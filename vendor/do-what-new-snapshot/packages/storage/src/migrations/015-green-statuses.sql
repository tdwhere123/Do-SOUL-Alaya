CREATE TABLE IF NOT EXISTS green_statuses (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'green_status',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  target_object_id       TEXT NOT NULL,
  target_object_kind     TEXT NOT NULL DEFAULT 'memory_entry',
  green_state            TEXT NOT NULL DEFAULT 'revoked',
  verification_basis     TEXT NOT NULL DEFAULT 'passive_stable',
  verified_by            TEXT NOT NULL DEFAULT 'user',
  verified_at            TEXT,
  valid_until            TEXT,
  bound_surfaces         TEXT NOT NULL DEFAULT '[]',
  bound_scope_class      TEXT,
  revoke_reason          TEXT NOT NULL DEFAULT 'none',
  last_transition_at     TEXT NOT NULL,
  workspace_id           TEXT NOT NULL,

  UNIQUE (target_object_id)
);

CREATE INDEX IF NOT EXISTS idx_green_statuses_target_object_id ON green_statuses(target_object_id);
CREATE INDEX IF NOT EXISTS idx_green_statuses_workspace_id ON green_statuses(workspace_id);
CREATE INDEX IF NOT EXISTS idx_green_statuses_green_state ON green_statuses(green_state);
CREATE INDEX IF NOT EXISTS idx_green_statuses_valid_until ON green_statuses(valid_until);
