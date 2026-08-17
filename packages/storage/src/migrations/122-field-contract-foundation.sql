CREATE TABLE source_records (
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  record_id           TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  source_version      TEXT NOT NULL,
  content_digest      TEXT NOT NULL,
  evidence_object_id  TEXT,
  recorded_at         TEXT NOT NULL,
  event_time          TEXT,
  valid_from          TEXT,
  valid_to            TEXT,
  operator_id         TEXT NOT NULL,
  source_body         TEXT,
  PRIMARY KEY (workspace_id, record_id),
  CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to > valid_from))
);

CREATE TABLE source_record_evidence_refs (
  workspace_id       TEXT NOT NULL,
  record_id          TEXT NOT NULL,
  evidence_object_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id, evidence_object_id),
  FOREIGN KEY (workspace_id, record_id)
    REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE
);

CREATE TABLE source_spans (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  span_id           TEXT NOT NULL,
  record_id         TEXT NOT NULL,
  start_offset      INTEGER NOT NULL,
  end_offset        INTEGER NOT NULL,
  purpose           TEXT NOT NULL,
  producer_version  TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, span_id),
  FOREIGN KEY (workspace_id, record_id)
    REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE,
  CHECK (start_offset >= 0 AND end_offset > start_offset),
  CHECK (purpose IN (
    'native_structure', 'sentence', 'line', 'proposed_subspan', 'claim_citation'
  )),
  UNIQUE (workspace_id, record_id, start_offset, end_offset, purpose, producer_version)
);

CREATE TABLE factor_descriptors (
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  factor_id           TEXT NOT NULL,
  family              TEXT NOT NULL CHECK (family IN ('f0', 'f1', 'f2', 'f3')),
  canonical_payload   TEXT,
  operator_id         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, factor_id),
  CHECK (canonical_payload IS NULL OR length(canonical_payload) > 0)
);

CREATE TABLE factor_incidences (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  incidence_id      TEXT NOT NULL,
  span_id           TEXT NOT NULL,
  factor_id         TEXT NOT NULL,
  scope             TEXT NOT NULL,
  operator_id       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, incidence_id),
  FOREIGN KEY (workspace_id, span_id)
    REFERENCES source_spans(workspace_id, span_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, factor_id)
    REFERENCES factor_descriptors(workspace_id, factor_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, span_id, factor_id, scope, operator_id)
);

CREATE TABLE derivation_jobs (
  workspace_id             TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  job_id                   TEXT NOT NULL,
  purpose                  TEXT NOT NULL,
  operator_id              TEXT NOT NULL,
  input_evidence_ids_json  TEXT NOT NULL CHECK (json_type(input_evidence_ids_json) = 'array'),
  status                   TEXT NOT NULL CHECK (
    status IN ('nominated', 'running', 'succeeded', 'failed', 'abandoned')
  ),
  disposition              TEXT NOT NULL,
  recorded_at              TEXT NOT NULL,
  PRIMARY KEY (workspace_id, job_id),
  UNIQUE (workspace_id, purpose, operator_id, input_evidence_ids_json)
);

CREATE TABLE field_projection_rebuild_requests (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  requested_at  TEXT NOT NULL
);

CREATE TABLE projection_generations (
  workspace_id               TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  generation_id              TEXT NOT NULL,
  operator_manifest_digest   TEXT NOT NULL,
  operator_versions_json     TEXT NOT NULL CHECK (json_type(operator_versions_json) = 'array'),
  schema_version             TEXT NOT NULL,
  input_event_frontier       TEXT NOT NULL,
  governance_frontier        TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (
    status IN ('shadow', 'verified', 'active', 'retired')
  ),
  recorded_at                TEXT NOT NULL,
  PRIMARY KEY (workspace_id, generation_id)
);

CREATE UNIQUE INDEX idx_projection_generations_one_active
  ON projection_generations(workspace_id) WHERE status = 'active';

CREATE TABLE projection_generation_artifacts (
  workspace_id     TEXT NOT NULL,
  generation_id    TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  artifacts_json   TEXT NOT NULL CHECK (json_type(artifacts_json) = 'object'),
  recorded_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, generation_id),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES projection_generations(workspace_id, generation_id) ON DELETE CASCADE
);

CREATE TABLE projection_generation_pointer (
  workspace_id          TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  active_generation_id  TEXT NOT NULL,
  activated_at          TEXT NOT NULL,
  FOREIGN KEY (workspace_id, active_generation_id)
    REFERENCES projection_generations(workspace_id, generation_id)
);

CREATE TABLE projection_pins (
  workspace_id    TEXT NOT NULL,
  generation_id   TEXT NOT NULL,
  reader_id       TEXT NOT NULL,
  pinned_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  released_at     TEXT,
  PRIMARY KEY (workspace_id, generation_id, reader_id),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES projection_generations(workspace_id, generation_id) ON DELETE CASCADE
);

CREATE INDEX idx_projection_pins_active
  ON projection_pins(workspace_id, generation_id, expires_at)
  WHERE released_at IS NULL;

CREATE TABLE projection_erase_barriers (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  barrier_id      TEXT NOT NULL,
  receipt_identity TEXT NOT NULL,
  generation_id   TEXT,
  subject_kind    TEXT NOT NULL CHECK (
    subject_kind IN ('source_record', 'source_span', 'factor', 'incidence', 'generation')
  ),
  subject_id      TEXT NOT NULL,
  erased_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, barrier_id),
  FOREIGN KEY (workspace_id, generation_id)
    REFERENCES projection_generations(workspace_id, generation_id)
);

CREATE TABLE causal_usage_receipts (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  identity         TEXT NOT NULL,
  causal_key       TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  downstream_ref   TEXT NOT NULL,
  weight           REAL NOT NULL,
  scope            TEXT NOT NULL,
  usage_kind       TEXT NOT NULL CHECK (usage_kind IN ('causal', 'delivery', 'inspection')),
  operator_id      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, identity),
  UNIQUE (workspace_id, causal_key),
  CHECK (typeof(weight) IN ('integer', 'real') AND weight >= 0 AND weight < 1e308),
  CHECK (usage_kind = 'causal' OR weight = 0)
);

CREATE TABLE proof_effect_decisions (
  workspace_id                   TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  request_digest                 TEXT NOT NULL,
  action                         TEXT NOT NULL,
  target                         TEXT NOT NULL,
  scope                          TEXT NOT NULL,
  effective_as_of                TEXT NOT NULL,
  decision                       TEXT NOT NULL CHECK (
    decision IN ('allow', 'deny', 'defer', 'require_confirmation')
  ),
  supporting_receipt_ids_json    TEXT NOT NULL CHECK (json_type(supporting_receipt_ids_json) = 'array'),
  recorded_at                    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, request_digest)
);

CREATE INDEX idx_source_records_workspace
  ON source_records(workspace_id, recorded_at, record_id);
CREATE INDEX idx_source_spans_workspace_record
  ON source_spans(workspace_id, record_id);
CREATE INDEX idx_factor_incidences_workspace
  ON factor_incidences(workspace_id, span_id, factor_id);
CREATE INDEX idx_derivation_jobs_workspace
  ON derivation_jobs(workspace_id, status, job_id);
CREATE INDEX idx_projection_generations_workspace
  ON projection_generations(workspace_id, status, generation_id);
CREATE INDEX idx_projection_generation_artifacts_workspace
  ON projection_generation_artifacts(workspace_id, generation_id);
CREATE INDEX idx_projection_erase_barriers_workspace
  ON projection_erase_barriers(workspace_id, generation_id, subject_id);
CREATE INDEX idx_causal_usage_receipts_workspace
  ON causal_usage_receipts(workspace_id, occurred_at, identity);

CREATE TRIGGER source_records_reject_erased_insert
BEFORE INSERT ON source_records
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'source_record'
    AND subject_id = NEW.record_id
)
AND NOT EXISTS (
  SELECT 1 FROM source_records
  WHERE workspace_id = NEW.workspace_id AND record_id = NEW.record_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source record cannot be admitted');
END;

CREATE TRIGGER source_records_reject_erased_body
BEFORE UPDATE OF source_body ON source_records
WHEN NEW.source_body IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'source_record'
    AND subject_id = NEW.record_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source record cannot store body');
END;

CREATE TRIGGER factor_descriptors_reject_erased_insert
BEFORE INSERT ON factor_descriptors
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'factor'
    AND subject_id = NEW.factor_id
)
AND NOT EXISTS (
  SELECT 1 FROM factor_descriptors
  WHERE workspace_id = NEW.workspace_id AND factor_id = NEW.factor_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased factor cannot be admitted');
END;

CREATE TRIGGER factor_descriptors_reject_erased_payload
BEFORE UPDATE OF canonical_payload ON factor_descriptors
WHEN NEW.canonical_payload IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'factor'
    AND subject_id = NEW.factor_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased factor cannot store payload');
END;

CREATE TRIGGER projection_generations_reject_active_insert
BEFORE INSERT ON projection_generations
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'generation activation requires a pointer swap');
END;

CREATE TRIGGER projection_generations_protect_pointer
BEFORE UPDATE OF status ON projection_generations
WHEN NEW.status != 'active'
 AND EXISTS (
  SELECT 1 FROM projection_generation_pointer
  WHERE workspace_id = NEW.workspace_id
    AND active_generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'pointed generation status requires pointer swap');
END;
