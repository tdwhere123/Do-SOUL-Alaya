-- Temporal assertions, projections, and recall embeddings.
CREATE INDEX idx_pma_workspace
ON project_mapping_anchors (workspace_id);

CREATE INDEX idx_pma_state
ON project_mapping_anchors (mapping_state);

CREATE INDEX idx_files_workspace_id ON files(workspace_id);

CREATE INDEX idx_files_run_id ON files(run_id);

CREATE INDEX idx_proposals_run_id
  ON proposals(run_id);

CREATE INDEX idx_health_journal_run_id
  ON health_journal(run_id);

CREATE UNIQUE INDEX idx_event_log_entity_revision
  ON event_log(entity_type, entity_id, revision);

CREATE INDEX idx_handoff_records_source_run ON handoff_records(source_run_id);

CREATE INDEX idx_handoff_records_expires ON handoff_records(expires_at);

CREATE INDEX idx_gap_records_detected_run ON gap_records(detected_in_run_id);

CREATE INDEX idx_gap_records_expires ON gap_records(expires_at);

CREATE INDEX idx_tool_specs_category
  ON tool_specs(category);

CREATE INDEX idx_tool_specs_scope_guard
  ON tool_specs(scope_guard);

CREATE INDEX idx_worker_runs_principal_state
  ON worker_runs(principal_run_id, state);

CREATE INDEX idx_tool_execution_records_principal_requestor
  ON tool_execution_records(requesting_principal_run_id, execution_id);

CREATE INDEX idx_tool_execution_records_worker_requestor
  ON tool_execution_records(requesting_worker_run_id, execution_id);

CREATE INDEX idx_tool_execution_records_tool
  ON tool_execution_records(tool_id, started_at);

CREATE INDEX idx_consolidation_trigger_budgets_source
  ON consolidation_trigger_budgets(trigger_source, cooldown_until);

CREATE INDEX idx_consolidation_trigger_budgets_subject
  ON consolidation_trigger_budgets(governance_subject, cooldown_until);

CREATE INDEX idx_consolidation_trigger_budgets_object_ref
  ON consolidation_trigger_budgets(source_object_ref, cooldown_until);

CREATE INDEX idx_deferred_obligations_run_state
  ON deferred_obligations(source_run_id, state);

CREATE INDEX idx_deferred_obligations_workspace_state
  ON deferred_obligations(workspace_id, state);

CREATE INDEX idx_deferred_obligations_state_expiry
  ON deferred_obligations(state, expires_at);

CREATE INDEX idx_dirty_state_dossiers_workspace
  ON dirty_state_dossiers(workspace_id, created_at);

CREATE INDEX idx_dirty_state_dossiers_worker_run
  ON dirty_state_dossiers(worker_run_id, created_at);

CREATE INDEX idx_dirty_state_dossiers_principal_run
  ON dirty_state_dossiers(principal_run_id, created_at);

CREATE INDEX idx_strong_refs_target_compound
  ON strong_refs (workspace_id, target_entity_type, target_entity_id);

CREATE INDEX idx_strong_refs_workspace_id
  ON strong_refs (workspace_id);

CREATE INDEX idx_path_relations_workspace ON path_relations(workspace_id);

CREATE INDEX idx_path_relations_updated ON path_relations(updated_at);

CREATE INDEX idx_snapshots_workspace_time
  ON path_graph_snapshots(workspace_id, snapshot_at DESC);

CREATE INDEX idx_ext_descriptors_type ON extension_descriptors(descriptor_type);

CREATE INDEX idx_ext_descriptors_source ON extension_descriptors(source);

CREATE INDEX idx_drift_leases_workspace_expires ON drift_leases(workspace_id, expires_at);

CREATE INDEX idx_drift_leases_expires ON drift_leases(expires_at);

CREATE UNIQUE INDEX idx_drift_leases_workspace_operation
  ON drift_leases(workspace_id, operation_type);

CREATE INDEX idx_event_log_workspace_id ON event_log(workspace_id);

CREATE INDEX idx_path_relations_source_anchor_key
ON path_relations(
  workspace_id,
  CASE json_extract(anchors_json, '$.source_anchor.kind')
    WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.source_anchor.object_id'))
    WHEN 'object_facet' THEN json_array(
      'object_facet',
      json_extract(anchors_json, '$.source_anchor.object_id'),
      json_extract(anchors_json, '$.source_anchor.facet_key')
    )
    WHEN 'obligation' THEN json_array(
      'obligation',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.obligation_digest')
    )
    WHEN 'risk_concern' THEN json_array(
      'risk_concern',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.concern_digest')
    )
    WHEN 'time_concern' THEN json_array(
      'time_concern',
      json_extract(anchors_json, '$.source_anchor.source_object_id'),
      json_extract(anchors_json, '$.source_anchor.window_digest')
    )
  END
);

CREATE INDEX idx_path_relations_target_anchor_key
ON path_relations(
  workspace_id,
  CASE json_extract(anchors_json, '$.target_anchor.kind')
    WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.target_anchor.object_id'))
    WHEN 'object_facet' THEN json_array(
      'object_facet',
      json_extract(anchors_json, '$.target_anchor.object_id'),
      json_extract(anchors_json, '$.target_anchor.facet_key')
    )
    WHEN 'obligation' THEN json_array(
      'obligation',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.obligation_digest')
    )
    WHEN 'risk_concern' THEN json_array(
      'risk_concern',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.concern_digest')
    )
    WHEN 'time_concern' THEN json_array(
      'time_concern',
      json_extract(anchors_json, '$.target_anchor.source_object_id'),
      json_extract(anchors_json, '$.target_anchor.window_digest')
    )
  END
);

CREATE INDEX idx_global_memory_entries_canonical_identity
ON global_memory_entries(canonical_identity);

CREATE INDEX idx_global_memory_entries_dimension_scope
ON global_memory_entries(dimension, scope_class);

CREATE INDEX idx_global_memory_recall_cache_workspace_classification
ON global_memory_recall_cache(workspace_id, classification);

CREATE INDEX idx_memory_embeddings_workspace
  ON memory_embeddings (workspace_id);

CREATE INDEX idx_memory_embeddings_workspace_provider_model
  ON memory_embeddings (workspace_id, provider_kind, model_id);

CREATE INDEX idx_global_memory_recall_cache_global_object_id
ON global_memory_recall_cache(global_object_id);

CREATE INDEX idx_trust_context_delivery_agent_target_delivered_at
ON trust_context_delivery(agent_target, delivered_at, delivery_id);

CREATE INDEX idx_trust_usage_proof_usage_state
ON trust_usage_proof(usage_state);

CREATE INDEX idx_orphan_radar_workspace
  ON orphan_radar(workspace_id, expires_at);

CREATE INDEX idx_orphan_radar_target
  ON orphan_radar(target_memory_id)
  WHERE target_memory_id IS NOT NULL;

CREATE UNIQUE INDEX idx_orphan_radar_target_event
  ON orphan_radar(target_event_id)
  WHERE target_event_id IS NOT NULL;

CREATE INDEX idx_event_log_workspace_type_created
  ON event_log(workspace_id, event_type, created_at);

CREATE INDEX idx_path_plasticity_watermark_updated
  ON path_plasticity_watermark(updated_at);

CREATE INDEX idx_proposal_reviewer_assignments_reviewer_deadline
  ON proposal_reviewer_assignments(reviewer_identity, deadline_at);

CREATE INDEX idx_garden_tasks_status_role ON garden_tasks(status, role);

CREATE INDEX idx_garden_tasks_workspace ON garden_tasks(workspace_id);

CREATE INDEX idx_garden_tasks_claimed_at ON garden_tasks(claimed_at) WHERE status = 'claimed';

CREATE INDEX idx_reconciliation_leases_expires_at
  ON reconciliation_leases (expires_at);

CREATE INDEX idx_edge_proposals_workspace_status
  ON edge_proposals(workspace_id, status, created_at);

CREATE INDEX idx_edge_proposals_filter
  ON edge_proposals(workspace_id, status, edge_type, trigger_source, confidence);

CREATE UNIQUE INDEX idx_edge_proposals_pending_unique
  ON edge_proposals(workspace_id, source_memory_id, target_memory_id, edge_type)
  WHERE status = 'pending';

CREATE INDEX idx_path_relation_co_usage_counters_updated
  ON path_relation_co_usage_counters(updated_at);

CREATE INDEX idx_path_relations_source_backing_object_id
ON path_relations(
  CASE json_extract(anchors_json, '$.source_anchor.kind')
    WHEN 'object' THEN json_extract(anchors_json, '$.source_anchor.object_id')
    WHEN 'object_facet' THEN json_extract(anchors_json, '$.source_anchor.object_id')
    WHEN 'obligation' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
    WHEN 'risk_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
    WHEN 'time_concern' THEN json_extract(anchors_json, '$.source_anchor.source_object_id')
  END,
  workspace_id
);

CREATE INDEX idx_path_relations_target_backing_object_id
ON path_relations(
  CASE json_extract(anchors_json, '$.target_anchor.kind')
    WHEN 'object' THEN json_extract(anchors_json, '$.target_anchor.object_id')
    WHEN 'object_facet' THEN json_extract(anchors_json, '$.target_anchor.object_id')
    WHEN 'obligation' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
    WHEN 'risk_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
    WHEN 'time_concern' THEN json_extract(anchors_json, '$.target_anchor.source_object_id')
  END,
  workspace_id
);

CREATE INDEX idx_enrich_pending_claimable
  ON enrich_pending(workspace_id, enqueued_at)
  WHERE processed_at IS NULL AND claimed_at IS NULL AND abandoned_at IS NULL;

CREATE INDEX idx_memory_entries_workspace_tier_active_created
ON memory_entries(workspace_id, storage_tier, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_workspace_dimension_hot_active_created
ON memory_entries(workspace_id, dimension, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_workspace_scope_hot_active_created
ON memory_entries(workspace_id, scope_class, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_run_active_created
ON memory_entries(run_id, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_health_issue_groups_workspace_state
  ON health_issue_groups (workspace_id, resolution_state, last_seen_at);

CREATE INDEX idx_health_issue_groups_target
  ON health_issue_groups (target_object_id);

CREATE INDEX idx_memory_entries_event_time
  ON memory_entries(workspace_id, event_time_start, event_time_end)
  WHERE event_time_start IS NOT NULL;

CREATE INDEX idx_memory_entries_preference_profile
ON memory_entries(workspace_id, preference_subject, preference_category, preference_object)
WHERE dimension = 'preference';

CREATE INDEX idx_memory_hq_workspace
  ON memory_hq (workspace_id);

CREATE INDEX idx_memory_entries_workspace_conflict_hot
  ON memory_entries(workspace_id, contradiction_count)
  WHERE contradiction_count > 0 AND storage_tier = 'hot';

CREATE UNIQUE INDEX idx_proposals_pending_strict_governance_unique
  ON proposals(workspace_id, derived_from, dossier_ref, target_object_kind)
  WHERE resolution_state = 'pending'
    AND dossier_ref = 'inspector.strict_governance_promotion'
    AND target_object_kind = 'path_relation'
    AND derived_from IS NOT NULL;

CREATE INDEX idx_memory_entry_evidence_refs_lookup
ON memory_entry_evidence_refs(workspace_id, evidence_ref, memory_id);

CREATE INDEX idx_source_grounding_defer_queue_enqueued
  ON source_grounding_defer_queue(enqueued_at, signal_id);

CREATE INDEX idx_source_grounding_defer_queue_workspace_enqueued
  ON source_grounding_defer_queue(workspace_id, enqueued_at, signal_id);

CREATE INDEX idx_source_grounding_defer_queue_claim_expiry
  ON source_grounding_defer_queue(workspace_id, claim_expires_at);

CREATE INDEX idx_source_grounding_defer_queue_admission
  ON source_grounding_defer_queue(workspace_id, capacity_blocked, enqueued_at, signal_id);

CREATE INDEX idx_relation_assertions_workspace_admitted
  ON relation_assertions(workspace_id, admitted_at, assertion_id);

CREATE INDEX idx_relation_assertion_quarantine_workspace
  ON relation_assertion_quarantine(workspace_id, source_kind, source_identity);

CREATE INDEX idx_relation_path_projections_workspace_generation
  ON relation_path_projections(workspace_id, generation, path_id);

CREATE INDEX idx_temporal_projection_selection_audit_selection
  ON temporal_projection_selection_audit(selection_id, transition_id);

CREATE INDEX idx_memory_entries_event_time_recall_active
  ON memory_entries(
    workspace_id,
    storage_tier,
    MIN(
      julianday(event_time_start),
      COALESCE(julianday(event_time_end), julianday(event_time_start))
    )
  )
  WHERE event_time_start IS NOT NULL
    AND julianday(event_time_start) IS NOT NULL
    AND (event_time_end IS NULL OR julianday(event_time_end) IS NOT NULL)
    AND COALESCE(retention_state, '') != 'tombstoned'
    AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_evidence_recall_embeddings_lookup
  ON evidence_recall_embeddings (
    workspace_id,
    provider_kind,
    model_id,
    schema_version,
    document_role
  );

CREATE INDEX idx_recall_routing_key_owners_lookup
ON recall_routing_key_owners(workspace_id, owner_id, owner_kind, signal_id);

CREATE INDEX idx_evidence_search_projections_workspace_owner
  ON evidence_search_projections(workspace_id, evidence_object_id);

CREATE INDEX idx_evidence_fact_frame_formations_workspace_owner
  ON evidence_fact_frame_formations(workspace_id, evidence_object_id);

CREATE INDEX idx_memory_hq_observations_workspace_object
  ON memory_hq_observations (workspace_id, object_id, observation_id);

CREATE INDEX idx_evidence_semantic_factor_formations_workspace_owner
  ON evidence_semantic_factor_formations(workspace_id, evidence_object_id);

CREATE INDEX idx_memory_object_keys_owner
  ON memory_object_keys(workspace_id, owner_id, normalized_surface);

CREATE INDEX idx_soft_association_paths_workspace
  ON soft_association_path_relations(workspace_id, created_at, path_id);

CREATE UNIQUE INDEX idx_projection_generations_one_active
  ON projection_generations(workspace_id) WHERE status = 'active';

CREATE INDEX idx_projection_pins_active
  ON projection_pins(workspace_id, generation_id, expires_at)
  WHERE released_at IS NULL;

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

CREATE UNIQUE INDEX projection_erase_barriers_subject_identity
ON projection_erase_barriers(workspace_id, subject_kind, subject_id);

CREATE INDEX idx_proof_effect_decisions_delivery
  ON proof_effect_decisions(workspace_id, actor_id, run_id, delivery_id);

CREATE INDEX idx_causal_usage_receipts_workspace
  ON causal_usage_receipts(workspace_id, occurred_at, identity);

CREATE TRIGGER memory_content_fts_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_content_fts_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_porter_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_porter_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_content_fts_porter_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;
