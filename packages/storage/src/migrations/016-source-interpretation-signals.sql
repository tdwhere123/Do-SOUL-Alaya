-- New observation signals carry no model category or probability. Historical
-- signals retain their original non-null fields and serialized payloads.
CREATE TABLE signals_interpretation (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT,
  source TEXT NOT NULL,
  signal_kind TEXT NOT NULL,
  object_kind TEXT,
  scope_hint TEXT,
  domain_tags_json TEXT NOT NULL,
  confidence REAL,
  evidence_refs_json TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  signal_state TEXT NOT NULL DEFAULT 'emitted',
  created_at TEXT NOT NULL,
  source_memory_refs_json TEXT NOT NULL DEFAULT '[]',
  supersedes_refs_json TEXT NOT NULL DEFAULT '[]',
  exception_to_refs_json TEXT NOT NULL DEFAULT '[]',
  contradicts_refs_json TEXT NOT NULL DEFAULT '[]',
  incompatible_with_refs_json TEXT NOT NULL DEFAULT '[]',
  source_delivery_ids_json TEXT,
  source_observation_json TEXT,
  interpretation_contract TEXT,
  CHECK (
    (interpretation_contract IS NULL AND object_kind IS NOT NULL AND confidence IS NOT NULL)
    OR (interpretation_contract IS NOT NULL AND interpretation_contract = 'source-interpretation-v1'
      AND object_kind IS NULL AND confidence IS NULL
      AND signal_kind = 'potential_semantic_observation' AND source = 'garden_compile'
      AND source_observation_json IS NOT NULL
      AND source_memory_refs_json = '[]' AND supersedes_refs_json = '[]'
      AND exception_to_refs_json = '[]' AND contradicts_refs_json = '[]'
      AND incompatible_with_refs_json = '[]')
  )
);
INSERT INTO signals_interpretation SELECT *, NULL FROM signals;
DROP TABLE signals;
ALTER TABLE signals_interpretation RENAME TO signals;
CREATE INDEX idx_signals_run_id ON signals(run_id);
CREATE INDEX idx_signals_workspace_id ON signals(workspace_id);
CREATE INDEX idx_signals_source ON signals(source);
CREATE INDEX idx_signals_kind ON signals(signal_kind);
