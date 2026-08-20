-- Workspaces, runs, EventLog, signals, and core memory objects.
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,
  default_engine_binding TEXT,
  workspace_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  archived_at TEXT,
  default_engine_class TEXT
  CHECK (
    default_engine_class IN ('coding_engine', 'conversation_engine')
    OR default_engine_class IS NULL
  ), repo_path TEXT);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  title TEXT NOT NULL,
  goal TEXT,
  run_mode TEXT NOT NULL,
  engine_binding_id TEXT,
  run_state TEXT NOT NULL DEFAULT 'idle',
  current_surface_id TEXT,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  engine_class TEXT);

CREATE TABLE event_log (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  caused_by TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE engine_bindings (
  binding_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  enable_tools INTEGER, api_key_ref TEXT);

CREATE TABLE signals (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT,
  source TEXT NOT NULL,
  signal_kind TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  scope_hint TEXT,
  domain_tags_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  signal_state TEXT NOT NULL DEFAULT 'emitted',
  created_at TEXT NOT NULL,
  source_memory_refs_json TEXT NOT NULL DEFAULT '[]', supersedes_refs_json TEXT NOT NULL DEFAULT '[]', exception_to_refs_json TEXT NOT NULL DEFAULT '[]', contradicts_refs_json TEXT NOT NULL DEFAULT '[]', incompatible_with_refs_json TEXT NOT NULL DEFAULT '[]', source_delivery_ids_json TEXT, source_observation_json TEXT);

CREATE TABLE evidence_capsules (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'evidence_capsule',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  semantic_anchor TEXT NOT NULL,
  event_anchor TEXT,
  physical_anchor TEXT,
  evidence_health_state TEXT NOT NULL DEFAULT 'verified',
  gist TEXT NOT NULL,
  excerpt TEXT,
  source_hash TEXT,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  surface_id TEXT
);

CREATE TABLE memory_entries (
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
  superseded_by           TEXT,
  forget_disposition TEXT, forget_disposition_ref TEXT, projection_schema_version INTEGER, event_time_start TEXT, event_time_end TEXT, valid_from TEXT, valid_to TEXT, time_precision TEXT, time_source TEXT, preference_subject TEXT, preference_predicate TEXT, preference_object TEXT, preference_category TEXT, preference_polarity TEXT, facet_tags TEXT, canonical_entities TEXT);

CREATE TABLE synthesis_capsules (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'synthesis_capsule',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  topic_key              TEXT NOT NULL,
  synthesis_type         TEXT NOT NULL,
  summary                TEXT NOT NULL,
  evidence_refs          TEXT NOT NULL DEFAULT '[]',
  source_memory_refs     TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  run_id                 TEXT NOT NULL,
  synthesis_status       TEXT NOT NULL DEFAULT 'working'
);

CREATE TABLE claim_forms (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'claim_form',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  governance_subject     TEXT NOT NULL,
  claim_kind             TEXT NOT NULL,
  scope_class            TEXT NOT NULL,
  enforcement_level      TEXT NOT NULL,
  origin_tier            TEXT NOT NULL,
  precedence_basis       TEXT NOT NULL,
  proposition_digest     TEXT NOT NULL,
  evidence_refs          TEXT NOT NULL DEFAULT '[]',
  source_object_refs     TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  claim_status           TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE proposals (
  runtime_id               TEXT PRIMARY KEY,
  object_kind              TEXT NOT NULL DEFAULT 'proposal',
  proposal_id              TEXT NOT NULL UNIQUE,
  task_surface_ref         TEXT,
  derived_from             TEXT,
  retention_policy         TEXT NOT NULL DEFAULT 'session_only',
  dossier_ref              TEXT,
  recommended_option_id    TEXT,
  proposal_options         TEXT NOT NULL DEFAULT '[]',
  resolution_state         TEXT NOT NULL DEFAULT 'pending',
  expires_at               TEXT,
  last_updated_at          TEXT NOT NULL,

  workspace_id             TEXT NOT NULL,
  run_id                   TEXT,
  reviewer_identity TEXT, target_object_kind TEXT NOT NULL DEFAULT 'memory_entry', proposed_change_summary TEXT NOT NULL DEFAULT '', created_at TEXT, proposed_changes TEXT CHECK (proposed_changes IS NULL OR json_valid(proposed_changes)), target_baseline_updated_at TEXT, source_delivery_ids TEXT, proposed_path_relation TEXT, proposal_operation TEXT
  CHECK (proposal_operation IS NULL OR proposal_operation IN ('memory_update', 'privacy_erase')));

CREATE TABLE slots (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'slot',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL DEFAULT 'system',

  governance_subject     TEXT NOT NULL,
  claim_kind             TEXT NOT NULL,
  scope_class            TEXT NOT NULL,
  winner_claim_id        TEXT,
  incumbent_since        TEXT,
  flip_conditions        TEXT NOT NULL DEFAULT '[]',

  workspace_id           TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE conflict_matrix_edges (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'conflict_matrix_edge',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  source_claim_id        TEXT NOT NULL,
  target_claim_id        TEXT NOT NULL,
  edge_type              TEXT NOT NULL,

  workspace_id           TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_claim_id) REFERENCES claim_forms(object_id) ON DELETE CASCADE,
  FOREIGN KEY (target_claim_id) REFERENCES claim_forms(object_id) ON DELETE CASCADE
);

CREATE TABLE surface_identities (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_identity',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  surface_kind TEXT NOT NULL,
  surface_status TEXT NOT NULL DEFAULT 'active',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE surface_anchors (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_anchor',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  anchor_value TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (surface_id, workspace_id)
    REFERENCES surface_identities(surface_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE surface_bindings (
  binding_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'surface_binding',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  object_id TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  binding_state TEXT NOT NULL DEFAULT 'active',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (surface_id, workspace_id) REFERENCES surface_identities(surface_id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE cross_cutting_permissions (
  permission_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'cross_cutting_permission',
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  object_id TEXT NOT NULL,
  cross_cutting_state TEXT NOT NULL DEFAULT 'none',
  allowed_surfaces TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE karma_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  workspace_id TEXT NOT NULL, run_id TEXT,
  CHECK (kind IN ('accept_gain', 'reject_penalty', 'reuse_gain', 'evidence_gain', 'supersede_penalty'))
);

CREATE TABLE green_statuses (
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

CREATE TABLE health_journal (
  entry_id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE project_mapping_anchors (
  object_id            TEXT PRIMARY KEY,
  object_kind          TEXT NOT NULL DEFAULT 'project_mapping_anchor',
  schema_version       INTEGER NOT NULL DEFAULT 1,
  lifecycle_state      TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL DEFAULT 'system',

  global_object_id     TEXT NOT NULL,
  project_id           TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  mapping_state        TEXT NOT NULL DEFAULT 'suggested',
  accepted_by          TEXT,
  last_transition_at   TEXT NOT NULL,

  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  workspace_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE handoff_records (
  runtime_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'handoff_record',
  task_surface_ref TEXT,
  expires_at TEXT,
  derived_from TEXT,
  retention_policy TEXT NOT NULL DEFAULT 'run_scoped',
  handoff_kind TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  target_run_id TEXT,
  surface_id TEXT,
  ttl_ms INTEGER,
  recurrence_runs INTEGER,
  recurrence_surfaces INTEGER,
  governance_impact REAL,
  unresolved_age_ms INTEGER,
  upgrade_candidate INTEGER
);

CREATE TABLE gap_records (
  runtime_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'gap_record',
  task_surface_ref TEXT,
  expires_at TEXT,
  derived_from TEXT,
  retention_policy TEXT NOT NULL DEFAULT 'run_scoped',
  gap_kind TEXT NOT NULL,
  detected_in_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT,
  description TEXT NOT NULL,
  ttl_ms INTEGER,
  recurrence_runs INTEGER,
  recurrence_surfaces INTEGER,
  governance_impact REAL,
  unresolved_age_ms INTEGER,
  upgrade_candidate INTEGER
);

CREATE TABLE tool_specs (
  tool_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(
    category IN ('read', 'write', 'exec', 'network', 'validation', 'evidence', 'memory', 'governance')
  ),
  description TEXT NOT NULL,
  scope_guard TEXT NOT NULL CHECK(
    scope_guard IN ('workspace', 'worktree', 'project', 'global')
  ),
  read_only INTEGER NOT NULL CHECK(read_only IN (0, 1)),
  destructive INTEGER NOT NULL CHECK(destructive IN (0, 1)),
  concurrency_safe INTEGER NOT NULL CHECK(concurrency_safe IN (0, 1)),
  interrupt_behavior TEXT NOT NULL CHECK(
    interrupt_behavior IN ('continue', 'wait', 'abort')
  ),
  requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN (0, 1)),
  requires_evidence_reopen INTEGER NOT NULL CHECK(requires_evidence_reopen IN (0, 1)),
  rollback_support TEXT NOT NULL CHECK(
    rollback_support IN ('none', 'best_effort', 'guaranteed')
  ),
  fast_path_eligible INTEGER NOT NULL CHECK(fast_path_eligible IN (0, 1))
);

CREATE TABLE worker_runs (
  worker_run_id TEXT PRIMARY KEY,
  principal_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requesting_principal_run_id TEXT,
  requesting_worker_run_id TEXT,
  engine_class TEXT NOT NULL CHECK(engine_class IN ('coding_engine', 'conversation_engine')),
  state TEXT NOT NULL CHECK(
    state IN ('init', 'active', 'completed', 'suspended', 'aborted', 'frozen')
  ),
  subtask_description TEXT NOT NULL,
  local_surface_ref TEXT NOT NULL,
  local_evidence_pointer TEXT,
  restricted_tool_set_json TEXT NOT NULL,
  local_budget_json TEXT NOT NULL,
  agreed_return_format_json TEXT NOT NULL,
  principal_security_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  CHECK(
    (requesting_principal_run_id IS NOT NULL AND requesting_worker_run_id IS NULL)
    OR
    (requesting_principal_run_id IS NULL AND requesting_worker_run_id IS NOT NULL)
  ),
  CHECK(updated_at >= created_at)
);

CREATE TABLE tool_execution_records (
  execution_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by IN ('principal', 'worker')),
  requesting_principal_run_id TEXT,
  requesting_worker_run_id TEXT,
  node_id TEXT,
  governance_decision_ref TEXT NOT NULL,
  permission_result TEXT NOT NULL CHECK(permission_result IN ('allow', 'ask', 'deny')),
  executed INTEGER NOT NULL CHECK(executed IN (0, 1)),
  started_at TEXT,
  ended_at TEXT,
  result_summary TEXT,
  rollback_status TEXT NOT NULL CHECK(
    rollback_status IN ('none', 'attempted', 'succeeded', 'failed')
  ),
  post_effect_refs_json TEXT NOT NULL DEFAULT '[]', affected_paths_json TEXT NULL,
  FOREIGN KEY (tool_id) REFERENCES tool_specs(tool_id),
  FOREIGN KEY (requesting_principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  CHECK(
    (requested_by = 'principal' AND requesting_principal_run_id IS NOT NULL AND requesting_worker_run_id IS NULL)
    OR
    (requested_by = 'worker' AND requesting_principal_run_id IS NULL AND requesting_worker_run_id IS NOT NULL)
  )
);

CREATE TABLE consolidation_trigger_budgets (
  trigger_id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL CHECK(
    trigger_source IN (
      'verification_failure',
      'repeated_override',
      'arbitration_burst',
      'bankruptcy_burst',
      'native_surface_drift'
    )
  ),
  governance_subject TEXT,
  source_object_ref TEXT,
  max_attempts_within_window INTEGER NOT NULL CHECK(max_attempts_within_window >= 1),
  attempts_used INTEGER NOT NULL CHECK(attempts_used >= 0),
  cooldown_until TEXT NOT NULL,
  CHECK(attempts_used <= max_attempts_within_window)
);

CREATE TABLE deferred_obligations (
  obligation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(
    kind IN ('safety_finding', 'data_cleanup', 'evidence_refresh', 'governance_pledge')
  ),
  state TEXT NOT NULL CHECK(state IN ('pending', 'fulfilled', 'expired', 'waived')),
  description TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_entity_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fulfilled_at TEXT,
  FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  CHECK(
    (state = 'fulfilled' AND fulfilled_at IS NOT NULL)
    OR
    (state != 'fulfilled' AND fulfilled_at IS NULL)
  )
);
