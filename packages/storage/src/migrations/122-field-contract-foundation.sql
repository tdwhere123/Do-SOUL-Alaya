CREATE TABLE source_records (
  record_id           TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  source_id           TEXT NOT NULL,
  source_version      TEXT NOT NULL,
  content_digest      TEXT NOT NULL,
  evidence_object_id  TEXT,
  recorded_at         TEXT NOT NULL,
  operator_version    TEXT NOT NULL,
  source_body         TEXT
);

CREATE TABLE source_spans (
  span_id           TEXT PRIMARY KEY,
  record_id         TEXT NOT NULL REFERENCES source_records(record_id) ON DELETE CASCADE,
  start_offset      INTEGER NOT NULL,
  end_offset        INTEGER NOT NULL,
  purpose           TEXT NOT NULL,
  producer_version  TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  CHECK (end_offset > start_offset),
  UNIQUE (record_id, start_offset, end_offset, purpose, producer_version)
);

CREATE TABLE factor_descriptors (
  factor_id           TEXT PRIMARY KEY,
  family              TEXT NOT NULL CHECK (family IN ('f0', 'f1', 'f2', 'f3')),
  canonical_payload   TEXT,
  operator_version    TEXT NOT NULL
);

CREATE TABLE factor_incidences (
  incidence_id      TEXT PRIMARY KEY,
  span_id           TEXT NOT NULL REFERENCES source_spans(span_id) ON DELETE CASCADE,
  factor_id         TEXT NOT NULL REFERENCES factor_descriptors(factor_id) ON DELETE CASCADE,
  scope             TEXT NOT NULL,
  operator_version  TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  UNIQUE (span_id, factor_id, scope, operator_version)
);

CREATE TABLE derivation_jobs (
  job_id                   TEXT PRIMARY KEY,
  purpose                  TEXT NOT NULL,
  operator_version         TEXT NOT NULL,
  input_evidence_ids_json  TEXT NOT NULL CHECK (json_valid(input_evidence_ids_json)),
  status                   TEXT NOT NULL CHECK (
    status IN ('nominated', 'running', 'succeeded', 'failed', 'abandoned')
  ),
  disposition              TEXT NOT NULL
);

CREATE TABLE projection_generations (
  generation_id              TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  operator_manifest_digest   TEXT NOT NULL,
  schema_version             TEXT NOT NULL,
  input_event_frontier       TEXT NOT NULL,
  governance_frontier        TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (
    status IN ('shadow', 'verified', 'active', 'retired')
  )
);

CREATE TABLE projection_generation_pointer (
  workspace_id          TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  active_generation_id  TEXT NOT NULL REFERENCES projection_generations(generation_id),
  activated_at          TEXT NOT NULL
);

CREATE TABLE projection_erase_barriers (
  barrier_id      TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  generation_id   TEXT REFERENCES projection_generations(generation_id),
  subject_kind    TEXT NOT NULL CHECK (
    subject_kind IN ('source_record', 'source_span', 'factor', 'incidence', 'generation')
  ),
  subject_id      TEXT NOT NULL,
  erased_at       TEXT NOT NULL
);

CREATE TABLE causal_usage_receipts (
  receipt_id       TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  causal_key       TEXT NOT NULL UNIQUE,
  occurred_at      TEXT NOT NULL,
  downstream_ref   TEXT NOT NULL,
  weight           REAL NOT NULL CHECK (weight >= 0),
  scope            TEXT NOT NULL,
  usage_kind       TEXT NOT NULL CHECK (usage_kind IN ('causal', 'delivery', 'inspection')),
  CHECK (usage_kind = 'causal' OR weight = 0)
);

CREATE TABLE proof_effect_decisions (
  request_digest                 TEXT PRIMARY KEY,
  action                         TEXT NOT NULL,
  target                         TEXT NOT NULL,
  scope                          TEXT NOT NULL,
  effective_as_of                TEXT NOT NULL,
  decision                       TEXT NOT NULL CHECK (
    decision IN ('allow', 'deny', 'defer', 'require_confirmation')
  ),
  supporting_receipt_ids_json    TEXT NOT NULL CHECK (json_valid(supporting_receipt_ids_json))
);

CREATE INDEX idx_source_records_workspace
  ON source_records(workspace_id, recorded_at, record_id);
CREATE INDEX idx_source_spans_workspace_record
  ON source_spans(workspace_id, record_id);
CREATE INDEX idx_factor_incidences_workspace
  ON factor_incidences(workspace_id, span_id, factor_id);
CREATE INDEX idx_derivation_jobs_status
  ON derivation_jobs(status, job_id);
CREATE INDEX idx_projection_generations_workspace
  ON projection_generations(workspace_id, status, generation_id);
CREATE INDEX idx_projection_erase_barriers_workspace
  ON projection_erase_barriers(workspace_id, generation_id, subject_id);
CREATE INDEX idx_causal_usage_receipts_workspace
  ON causal_usage_receipts(workspace_id, occurred_at, receipt_id);
