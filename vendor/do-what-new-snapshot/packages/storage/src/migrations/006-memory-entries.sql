CREATE TABLE IF NOT EXISTS memory_entries (
  object_id               TEXT PRIMARY KEY,
  object_kind             TEXT NOT NULL DEFAULT 'memory_entry',
  schema_version          INTEGER NOT NULL DEFAULT 1,
  lifecycle_state         TEXT NOT NULL DEFAULT 'active',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  created_by              TEXT NOT NULL,

  dimension               TEXT NOT NULL,
  source_kind             TEXT NOT NULL,
  formation_kind          TEXT NOT NULL,
  scope_class             TEXT NOT NULL,
  content                 TEXT NOT NULL,
  domain_tags             TEXT NOT NULL DEFAULT '[]',
  evidence_refs           TEXT NOT NULL DEFAULT '[]',

  workspace_id            TEXT NOT NULL,
  run_id                  TEXT NOT NULL,
  surface_id              TEXT,
  storage_tier            TEXT NOT NULL DEFAULT 'hot',

  activation_score        REAL,
  retention_score         REAL,
  manifestation_state     TEXT,
  retention_state         TEXT,
  decay_profile           TEXT,
  confidence              REAL,
  last_used_at            TEXT,
  last_hit_at             TEXT,
  reinforcement_count     INTEGER,
  contradiction_count     INTEGER,
  superseded_by           TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_id ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_run_id ON memory_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_dimension ON memory_entries(dimension);
CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_class ON memory_entries(scope_class);
CREATE INDEX IF NOT EXISTS idx_memory_entries_storage_tier ON memory_entries(storage_tier);
