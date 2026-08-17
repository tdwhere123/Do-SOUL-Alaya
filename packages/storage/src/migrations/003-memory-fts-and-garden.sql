-- Global memory, embeddings, FTS, Garden, and health groups.
CREATE TABLE evidence_semantic_factor_formations (
  evidence_object_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL CHECK (
    operator_id = 'open_semantic_factor_formation_v1'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('formed', 'ineligible', 'unavailable', 'rejected')
  ),
  producer_operator_id TEXT,
  source_sha256 TEXT,
  graph_json TEXT,
  capture_digest TEXT NOT NULL CHECK (
    length(capture_digest) = 71 AND
    substr(capture_digest, 1, 7) = 'sha256:'
  ),
  FOREIGN KEY (evidence_object_id)
    REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  CHECK (
    source_sha256 IS NULL OR (
      length(source_sha256) = 71 AND
      substr(source_sha256, 1, 7) = 'sha256:'
    )
  ),
  CHECK (
    producer_operator_id IS NULL OR length(trim(producer_operator_id)) > 0
  ),
  CHECK (
    (
      status = 'formed' AND
      producer_operator_id IS NOT NULL AND
      source_sha256 IS NOT NULL AND
      graph_json IS NOT NULL AND
      json_valid(graph_json) AND
      json_type(graph_json) = 'object'
    ) OR (
      status != 'formed' AND
      graph_json IS NULL
    )
  )
);

CREATE TABLE memory_object_keys (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_type TEXT NOT NULL CHECK (
    key_type IN (
      'gist_remainder',
      'osf_surface',
      'osf_identity',
      'temporal_alias',
      'numeric_alias'
    )
  ),
  surface TEXT NOT NULL CHECK (length(trim(surface)) > 0),
  normalized_surface TEXT NOT NULL CHECK (length(trim(normalized_surface)) > 0),
  language TEXT CHECK (language IS NULL OR language IN ('en', 'zh', 'und')),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('evidence_gist', 'osf_factor', 'stored_text')
  ),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
  PRIMARY KEY (workspace_id, owner_id, key_id),
  FOREIGN KEY (owner_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

CREATE TABLE soft_association_path_relations (
  path_id                   TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  anchors_json              TEXT NOT NULL CHECK (json_valid(anchors_json)),
  constitution_json         TEXT NOT NULL CHECK (json_valid(constitution_json)),
  effect_vector_json        TEXT NOT NULL CHECK (json_valid(effect_vector_json)),
  plasticity_state_json     TEXT NOT NULL CHECK (json_valid(plasticity_state_json)),
  lifecycle_json            TEXT NOT NULL CHECK (json_valid(lifecycle_json)),
  legitimacy_json           TEXT NOT NULL CHECK (json_valid(legitimacy_json)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK (json_extract(anchors_json, '$.source_anchor.kind') = 'object'),
  CHECK (json_extract(anchors_json, '$.target_anchor.kind') = 'object'),
  CHECK (json_extract(constitution_json, '$.relation_kind') = 'co_recalled'),
  CHECK (json_extract(effect_vector_json, '$.recall_bias') > 0),
  CHECK (json_extract(lifecycle_json, '$.status') = 'active'),
  CHECK (json_extract(legitimacy_json, '$.governance_class') = 'attention_only'),
  CHECK (json_array_length(json_extract(legitimacy_json, '$.evidence_basis')) = 1),
  CHECK (json_extract(legitimacy_json, '$.evidence_basis[0]') = 'recalls_edge_co_usage')
);

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

CREATE TABLE "proof_effect_decisions_v1_history" (
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

CREATE TABLE proof_effect_decisions (
  workspace_id                   TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  request_digest                 TEXT NOT NULL,
  schema_version                INTEGER NOT NULL CHECK (schema_version = 2),
  actor_id                       TEXT NOT NULL,
  run_id                         TEXT NOT NULL,
  delivery_id                    TEXT NOT NULL,
  action                         TEXT NOT NULL,
  target                         TEXT NOT NULL,
  scope                          TEXT NOT NULL,
  effective_as_of                TEXT NOT NULL,
  decision                       TEXT NOT NULL CHECK (
    decision IN ('allow', 'deny', 'defer', 'require_confirmation')
  ),
  supporting_receipt_ids_json    TEXT NOT NULL CHECK (
    json_type(supporting_receipt_ids_json) = 'array'
  ),
  supporting_proof_witnesses_json TEXT NOT NULL CHECK (
    json_type(supporting_proof_witnesses_json) = 'array'
  ),
  governance_frontier            TEXT NOT NULL,
  policy_operator_id             TEXT NOT NULL,
  policy_operator_version        TEXT NOT NULL,
  recorded_at                    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, request_digest)
);

CREATE TABLE "causal_usage_receipts" (
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
  UNIQUE (workspace_id, causal_key, downstream_ref),
  CHECK (typeof(weight) IN ('integer', 'real') AND weight >= 0 AND weight < 1e308),
  CHECK (usage_kind = 'causal' OR weight = 0)
);

CREATE VIRTUAL TABLE memory_content_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');

CREATE VIRTUAL TABLE memory_content_fts_porter USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE evidence_capsule_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE evidence_capsule_fts_trigram USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');

CREATE VIRTUAL TABLE synthesis_capsule_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE synthesis_capsule_fts_trigram USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');

CREATE VIRTUAL TABLE evidence_search_projection_fts USING fts5(
  evidence_object_id UNINDEXED,
  projection_id UNINDEXED,
  projection_kind UNINDEXED,
  workspace_id,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE evidence_search_projection_fts_trigram USING fts5(
  evidence_object_id UNINDEXED,
  projection_id UNINDEXED,
  projection_kind UNINDEXED,
  workspace_id,
  content,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE memory_object_key_fts USING fts5(
  owner_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE memory_object_key_fts_trigram USING fts5(
  owner_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'trigram'
);

CREATE INDEX idx_event_log_run_id ON event_log(run_id);

CREATE INDEX idx_event_log_entity ON event_log(entity_type, entity_id);

CREATE INDEX idx_event_log_type ON event_log(event_type);

CREATE INDEX idx_engine_bindings_workspace_id ON engine_bindings(workspace_id);

CREATE INDEX idx_signals_run_id ON signals(run_id);

CREATE INDEX idx_signals_workspace_id ON signals(workspace_id);

CREATE INDEX idx_signals_source ON signals(source);

CREATE INDEX idx_signals_kind ON signals(signal_kind);

CREATE INDEX idx_evidence_capsules_run_id ON evidence_capsules(run_id);

CREATE INDEX idx_evidence_capsules_workspace_id ON evidence_capsules(workspace_id);

CREATE INDEX idx_evidence_capsules_health ON evidence_capsules(evidence_health_state);

CREATE INDEX idx_memory_entries_workspace_id ON memory_entries(workspace_id);

CREATE INDEX idx_memory_entries_run_id ON memory_entries(run_id);

CREATE INDEX idx_memory_entries_dimension ON memory_entries(dimension);

CREATE INDEX idx_memory_entries_scope_class ON memory_entries(scope_class);

CREATE INDEX idx_memory_entries_storage_tier ON memory_entries(storage_tier);

CREATE INDEX idx_synthesis_capsules_workspace_id ON synthesis_capsules(workspace_id);

CREATE INDEX idx_synthesis_capsules_topic_key ON synthesis_capsules(topic_key);

CREATE INDEX idx_claim_forms_workspace_id ON claim_forms(workspace_id);

CREATE INDEX idx_claim_forms_claim_status ON claim_forms(claim_status);

CREATE INDEX idx_claim_forms_claim_kind ON claim_forms(claim_kind);

CREATE INDEX idx_claim_forms_governance_subject
  ON claim_forms(json_extract(governance_subject, '$.canonical_key'));

CREATE INDEX idx_proposals_workspace_id ON proposals(workspace_id);

CREATE INDEX idx_proposals_resolution_state ON proposals(resolution_state);

CREATE INDEX idx_proposals_proposal_id ON proposals(proposal_id);

CREATE UNIQUE INDEX idx_slots_unique_key ON slots(
  json_extract(governance_subject, '$.canonical_key'),
  claim_kind,
  scope_class,
  workspace_id
);

CREATE INDEX idx_slots_workspace ON slots(workspace_id);

CREATE INDEX idx_slots_winner ON slots(winner_claim_id) WHERE winner_claim_id IS NOT NULL;

CREATE INDEX idx_conflict_edges_source ON conflict_matrix_edges(source_claim_id);

CREATE INDEX idx_conflict_edges_target ON conflict_matrix_edges(target_claim_id);

CREATE INDEX idx_conflict_edges_workspace ON conflict_matrix_edges(workspace_id);

CREATE UNIQUE INDEX idx_conflict_edges_unique
  ON conflict_matrix_edges(source_claim_id, target_claim_id, edge_type);

CREATE UNIQUE INDEX idx_surface_identities_surface
  ON surface_identities(surface_id, workspace_id);

CREATE INDEX idx_surface_identities_workspace
  ON surface_identities(workspace_id);

CREATE INDEX idx_surface_identities_status
  ON surface_identities(surface_status);

CREATE INDEX idx_surface_anchors_surface
  ON surface_anchors(surface_id, workspace_id);

CREATE INDEX idx_surface_anchors_workspace
  ON surface_anchors(workspace_id);

CREATE UNIQUE INDEX idx_surface_bindings_primary
  ON surface_bindings(object_id, workspace_id) WHERE is_primary = 1 AND binding_state != 'detached';

CREATE UNIQUE INDEX idx_surface_bindings_object_surface
  ON surface_bindings(object_id, surface_id, workspace_id);

CREATE INDEX idx_surface_bindings_object
  ON surface_bindings(object_id, workspace_id);

CREATE INDEX idx_surface_bindings_surface
  ON surface_bindings(surface_id, workspace_id);

CREATE INDEX idx_surface_bindings_workspace
  ON surface_bindings(workspace_id);

CREATE UNIQUE INDEX idx_cross_cutting_object
  ON cross_cutting_permissions(object_id, workspace_id);

CREATE INDEX idx_cross_cutting_workspace
  ON cross_cutting_permissions(workspace_id);

CREATE INDEX idx_karma_events_object_id
  ON karma_events(object_id);

CREATE INDEX idx_karma_events_workspace_id
  ON karma_events(workspace_id);

CREATE INDEX idx_karma_events_created_at
  ON karma_events(created_at);

CREATE INDEX idx_green_statuses_target_object_id ON green_statuses(target_object_id);

CREATE INDEX idx_green_statuses_workspace_id ON green_statuses(workspace_id);

CREATE INDEX idx_green_statuses_green_state ON green_statuses(green_state);

CREATE INDEX idx_green_statuses_valid_until ON green_statuses(valid_until);

CREATE INDEX idx_health_journal_workspace_created
  ON health_journal (workspace_id, created_at DESC);

CREATE INDEX idx_health_journal_workspace_kind
  ON health_journal (workspace_id, event_kind, created_at DESC);

CREATE UNIQUE INDEX idx_pma_unique
ON project_mapping_anchors (global_object_id, workspace_id);
