CREATE TABLE IF NOT EXISTS synthesis_capsules (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'synthesis_capsule',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  topic_key              TEXT NOT NULL,
  synthesis_type         TEXT NOT NULL,
  authority_round_count  INTEGER NOT NULL DEFAULT 0,
  cooldown_until         TEXT,
  promotion_state        TEXT NOT NULL DEFAULT 'none',
  summary                TEXT NOT NULL,
  evidence_refs          TEXT NOT NULL DEFAULT '[]',
  source_memory_refs     TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  run_id                 TEXT NOT NULL,
  synthesis_status       TEXT NOT NULL DEFAULT 'working'
);

CREATE INDEX IF NOT EXISTS idx_synthesis_capsules_workspace_id ON synthesis_capsules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_synthesis_capsules_topic_key ON synthesis_capsules(topic_key);
CREATE INDEX IF NOT EXISTS idx_synthesis_capsules_promotion_state ON synthesis_capsules(promotion_state);
