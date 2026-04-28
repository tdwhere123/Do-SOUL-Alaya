CREATE TABLE IF NOT EXISTS global_memory_entries (
  global_object_id      TEXT PRIMARY KEY,
  object_kind           TEXT NOT NULL DEFAULT 'global_memory_entry',
  canonical_identity    TEXT NOT NULL,
  dimension             TEXT NOT NULL,
  scope_class           TEXT NOT NULL,
  content               TEXT NOT NULL,
  domain_tags           TEXT NOT NULL DEFAULT '[]',
  provenance            TEXT NOT NULL,
  activation_score      REAL,
  version               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_global_memory_entries_canonical_identity
ON global_memory_entries(canonical_identity);

CREATE INDEX IF NOT EXISTS idx_global_memory_entries_dimension_scope
ON global_memory_entries(dimension, scope_class);
