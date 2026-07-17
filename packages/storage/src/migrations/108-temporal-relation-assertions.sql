-- Offline-only: initDatabase executes this only for a fresh bootstrap or an
-- explicitly selected candidate copy. Runtime startup must never apply it to
-- a source database in place.

ALTER TABLE signals
  ADD COLUMN source_delivery_ids_json TEXT;

ALTER TABLE signals
  ADD COLUMN source_observation_json TEXT;

CREATE TABLE relation_assertions (
  assertion_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  admission_event_id TEXT NOT NULL UNIQUE,
  identity_key TEXT NOT NULL UNIQUE,
  anchors_json TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  validity_json TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);

CREATE INDEX idx_relation_assertions_workspace_admitted
  ON relation_assertions(workspace_id, admitted_at, assertion_id);

CREATE TABLE relation_assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES relation_assertions(assertion_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (assertion_id, evidence_id)
);

CREATE TABLE relation_assertion_resolution_current (
  assertion_id TEXT PRIMARY KEY REFERENCES relation_assertions(assertion_id) ON DELETE CASCADE,
  resolution_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  resolution_event_id TEXT NOT NULL UNIQUE,
  resolution_kind TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE relation_assertion_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  UNIQUE(source_kind, source_identity, source_digest)
);

CREATE INDEX idx_relation_assertion_quarantine_workspace
  ON relation_assertion_quarantine(workspace_id, source_kind, source_identity);

CREATE TABLE temporal_projection_generations (
  generation TEXT PRIMARY KEY,
  assertion_schema_generation TEXT NOT NULL,
  assertion_event_contract_generation TEXT NOT NULL,
  projection_schema_generation TEXT NOT NULL,
  projection_policy_id TEXT NOT NULL,
  projection_policy_sha256 TEXT NOT NULL,
  history_digest TEXT NOT NULL,
  as_of TEXT NOT NULL,
  projection_count INTEGER NOT NULL,
  projection_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE TABLE relation_path_projections (
  generation TEXT NOT NULL REFERENCES temporal_projection_generations(generation) ON DELETE CASCADE,
  path_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL REFERENCES relation_assertions(assertion_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  PRIMARY KEY (generation, path_id),
  UNIQUE (generation, assertion_id)
);

CREATE INDEX idx_relation_path_projections_workspace_generation
  ON relation_path_projections(workspace_id, generation, path_id);

CREATE TABLE temporal_schema_state (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
  assertion_schema_generation TEXT NOT NULL,
  assertion_event_contract_generation TEXT NOT NULL,
  projection_schema_generation TEXT NOT NULL,
  active_projection_generation TEXT,
  active_as_of TEXT,
  projection_policy_id TEXT,
  projection_policy_sha256 TEXT,
  history_digest TEXT,
  projection_count INTEGER NOT NULL,
  projection_digest TEXT,
  status TEXT NOT NULL,
  temporal_projection_selection_required INTEGER NOT NULL DEFAULT 0
    CHECK (temporal_projection_selection_required IN (0, 1)),
  updated_at TEXT NOT NULL,
  temporal_projection_selected INTEGER NOT NULL DEFAULT 0
    CHECK (temporal_projection_selected IN (0, 1)),
  selection_id TEXT,
  selected_at TEXT
);

CREATE TABLE temporal_projection_selection_audit (
  transition_id TEXT PRIMARY KEY,
  selection_id TEXT NOT NULL,
  transition_kind TEXT NOT NULL CHECK (transition_kind IN ('selected', 'rolled_back')),
  previous_selected INTEGER NOT NULL CHECK (previous_selected IN (0, 1)),
  next_selected INTEGER NOT NULL CHECK (next_selected IN (0, 1)),
  candidate_sha256 TEXT NOT NULL,
  source_file_set_digest TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX idx_temporal_projection_selection_audit_selection
  ON temporal_projection_selection_audit(selection_id, transition_id);

CREATE TRIGGER block_legacy_path_relation_insert_when_temporal_projection_selected
BEFORE INSERT ON path_relations
WHEN NOT EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 0
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;

CREATE TRIGGER block_legacy_path_relation_update_when_temporal_projection_selected
BEFORE UPDATE ON path_relations
WHEN NOT EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 0
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;

CREATE TRIGGER block_legacy_path_relation_delete_when_temporal_projection_selected
BEFORE DELETE ON path_relations
WHEN NOT EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 0
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;
