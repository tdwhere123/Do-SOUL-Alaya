-- Surfaces, files, tools, leases, and control-plane records.
CREATE TABLE dirty_state_dossiers (
  dossier_id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL,
  principal_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(
    trigger IN (
      'evidence_corruption',
      'governance_bypass',
      'state_inconsistency',
      'budget_violation',
      'safety_gate_failure',
      'manual'
    )
  ),
  panic_source TEXT NOT NULL,
  panic_summary TEXT NOT NULL,
  affected_data_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE "strong_refs" (
  ref_id TEXT PRIMARY KEY,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_type TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('governance_lease', 'security_snapshot', 'active_projection')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, source_entity_id, target_entity_id, reason)
);

CREATE TABLE path_relations (
  path_id         TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  anchors_json    TEXT NOT NULL,
  constitution_json TEXT NOT NULL,
  effect_vector_json TEXT NOT NULL,
  plasticity_state_json TEXT NOT NULL,
  lifecycle_json  TEXT NOT NULL,
  legitimacy_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE path_graph_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  metrics_json    TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL
);

CREATE TABLE extension_descriptors (
  descriptor_id   TEXT PRIMARY KEY,
  descriptor_type TEXT NOT NULL,
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,
  metadata_json   TEXT NOT NULL,
  registered_at   TEXT NOT NULL
);

CREATE TABLE drift_leases (
  lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  granted_to TEXT NOT NULL,
  drift_id TEXT,
  expires_at TEXT NOT NULL,
  granted_at TEXT NOT NULL
);

CREATE TABLE bootstrapping_records (
  record_id          TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL UNIQUE REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  paths_planted      INTEGER NOT NULL,
  template_ids_json  TEXT NOT NULL,
  planted_at         TEXT NOT NULL
);

CREATE TABLE global_memory_entries (
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

CREATE TABLE global_memory_recall_cache (
  workspace_id          TEXT NOT NULL,
  global_object_id      TEXT NOT NULL,
  classification        TEXT NOT NULL CHECK (classification IN ('included', 'excluded')),
  updated_at            TEXT NOT NULL,

  PRIMARY KEY (workspace_id, global_object_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (global_object_id) REFERENCES global_memory_entries(global_object_id) ON DELETE CASCADE
);

CREATE TABLE memory_embeddings (
  object_id TEXT PRIMARY KEY REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  vector_valid INTEGER NOT NULL DEFAULT 0
  CHECK (vector_valid IN (0, 1)));

CREATE TABLE trust_context_delivery (
  delivery_id TEXT PRIMARY KEY,
  agent_target TEXT NOT NULL,
  workspace_id TEXT,
  run_id TEXT,
  delivered_object_ids_json TEXT NOT NULL CHECK (json_valid(delivered_object_ids_json)),
  delivered_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE
);

CREATE TABLE trust_usage_proof (
  delivery_id TEXT PRIMARY KEY,
  usage_state TEXT NOT NULL CHECK (usage_state IN ('used', 'skipped', 'not_applicable')),
  used_object_ids_json TEXT NOT NULL CHECK (json_valid(used_object_ids_json)),
  reason TEXT,
  reported_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE, per_anchor_usage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(per_anchor_usage_json)), trust_mode TEXT CHECK (trust_mode IN ('manual', 'automatic')),
  FOREIGN KEY(delivery_id) REFERENCES trust_context_delivery(delivery_id) ON DELETE CASCADE
);

CREATE TABLE "orphan_radar" (
  radar_id TEXT NOT NULL PRIMARY KEY,
  target_memory_id TEXT,
  target_event_id TEXT,
  target_event_type TEXT,
  expected_table TEXT CHECK(expected_table IN ('trust_context_delivery', 'trust_usage_proof')),
  workspace_id TEXT NOT NULL,
  suspected_surface_gaps_json TEXT NOT NULL DEFAULT '[]',
  suggested_action TEXT NOT NULL CHECK(
    suggested_action IN ('re_anchor_candidate', 'archive_candidate', 'no_action')
  ),
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  detected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  requires_review INTEGER NOT NULL DEFAULT 0,
  CHECK(expires_at > detected_at),
  CHECK(
    (
      target_memory_id IS NOT NULL
      AND target_event_id IS NULL
      AND target_event_type IS NULL
      AND expected_table IS NULL
    )
    OR (
      target_memory_id IS NULL
      AND target_event_id IS NOT NULL
      AND target_event_type IS NOT NULL
      AND expected_table IS NOT NULL
    )
  ),
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE path_plasticity_watermark (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  last_processed_reported_at TEXT NOT NULL,
  last_processed_audit_event_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE proposal_reviewer_assignments (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  reviewer_identity TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  deadline_at TEXT,
  escalation_after_ms INTEGER CHECK (escalation_after_ms IS NULL OR escalation_after_ms >= 0)
);

CREATE TABLE garden_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_text TEXT,
  completion_envelope_json TEXT);

CREATE TABLE reconciliation_leases (
  lease_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE edge_proposals (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  source_memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT,
  source_signal_id TEXT,
  run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'auto_accepted')),
  reviewer_identity TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (source_memory_id <> target_memory_id)
);

CREATE TABLE path_relation_co_usage_counters (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  low_memory_id   TEXT NOT NULL,
  high_memory_id  TEXT NOT NULL,
  count           INTEGER NOT NULL,
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, low_memory_id, high_memory_id)
);

CREATE TABLE enrich_pending (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  memory_id       TEXT NOT NULL,
  run_id          TEXT,
  source_signal_id TEXT,
  enqueued_at     TEXT NOT NULL,
  claimed_at      TEXT,
  processed_at    TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, abandoned_at TEXT,
  PRIMARY KEY (workspace_id, memory_id)
);

CREATE TABLE "health_issue_groups" (
  group_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  target_object_kind TEXT NOT NULL,
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (
    'orphan_radar', 'green_revoked', 'evidence_failure', 'path_relation_failure',
    'recall_auxiliary_failure'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'blocking')),
  confidence REAL NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  suggested_actions_json TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN (
    'pending', 'resolved', 'suppressed'
  )),
  resolved_at TEXT,
  resolved_by TEXT,
  UNIQUE (workspace_id, target_object_id, cause_kind)
);

CREATE TABLE memory_hq (
  object_id TEXT PRIMARY KEY REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  hqs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  observation_id TEXT REFERENCES memory_hq_observations(observation_id));

CREATE TABLE memory_entry_evidence_refs (
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (workspace_id, memory_id, evidence_ref),
  FOREIGN KEY (memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

CREATE TABLE source_grounding_defer_queue (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  defer_reason TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  claim_token TEXT, claim_token_fingerprint TEXT, claim_expires_at TEXT, capacity_blocked INTEGER NOT NULL DEFAULT 0 CHECK(capacity_blocked IN (0, 1)));

CREATE TABLE source_grounding_defer_reason_counts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  defer_reason TEXT NOT NULL,
  enqueue_count INTEGER NOT NULL CHECK(enqueue_count >= 0),
  PRIMARY KEY (workspace_id, defer_reason)
);

CREATE TABLE relation_assertions (
  assertion_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  admission_event_id TEXT NOT NULL UNIQUE,
  identity_key TEXT NOT NULL UNIQUE,
  anchors_json TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  validity_json TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  formation_receipt_json TEXT);

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
  selected_at TEXT,
  projection_refresh_required INTEGER NOT NULL DEFAULT 0
  CHECK (projection_refresh_required IN (0, 1)));

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

CREATE TABLE evidence_recall_embeddings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  owner_object_id TEXT NOT NULL REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  document_identity TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  document_role TEXT NOT NULL CHECK (document_role = 'evidence_document'),
  provider_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding_blob BLOB NOT NULL,
  vector_valid INTEGER NOT NULL DEFAULT 1 CHECK (vector_valid IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id,
    owner_object_id,
    document_identity,
    document_role
  )
);

CREATE TABLE recall_routing_key_owners (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_kind, owner_id, signal_id)
);

CREATE TABLE evidence_search_projections (
  evidence_object_id TEXT NOT NULL,
  projection_id INTEGER NOT NULL CHECK (projection_id > 0),
  projection_kind TEXT NOT NULL CHECK (
    projection_kind IN ('user_assertion', 'assistant_observation', 'fact_key')
  ),
  workspace_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  PRIMARY KEY (evidence_object_id, projection_kind, projection_id),
  FOREIGN KEY (evidence_object_id) REFERENCES evidence_capsules(object_id) ON DELETE CASCADE
);

CREATE TABLE evidence_fact_frame_formations (
  evidence_object_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL CHECK (
    operator_id = 'evidence_fact_frame_formation_v1'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('formed', 'ineligible', 'unavailable', 'rejected')
  ),
  producer_operator_id TEXT,
  source_hash TEXT,
  fact_frame_json TEXT,
  capture_digest TEXT NOT NULL CHECK (
    length(capture_digest) = 71 AND
    substr(capture_digest, 1, 7) = 'sha256:'
  ),
  FOREIGN KEY (evidence_object_id)
    REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  CHECK (
    (
      status = 'formed' AND
      producer_operator_id IS NOT NULL AND
      length(trim(producer_operator_id)) > 0 AND
      source_hash IS NOT NULL AND
      length(trim(source_hash)) > 0 AND
      fact_frame_json IS NOT NULL AND
      json_valid(fact_frame_json) AND
      json_type(fact_frame_json) = 'object'
    ) OR (
      status != 'formed' AND
      fact_frame_json IS NULL
    )
  )
);

CREATE TABLE relation_assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES relation_assertions(assertion_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_occurred_at TEXT NOT NULL,
  PRIMARY KEY (assertion_id, evidence_id)
);

CREATE TABLE memory_hq_observations (
  observation_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_capsules(object_id) ON DELETE RESTRICT,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_occurred_at TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  hqs_json TEXT NOT NULL,
  hq_content_sha256 TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (object_id, evidence_id, source_event_id, observation_sha256)
);
