-- Remove rows left by earlier workspace deletions. Backfill objects inherit
-- scope from their run. SourceIndex text deletion also removes its FTS rows.
-- The migration runner clears installed Garden attachments before the task
-- deletes and prunes the orphaned generation-specific FTS tables afterward.
DELETE FROM garden_embedding_backfill_objects
WHERE NOT EXISTS (
  SELECT 1 FROM garden_embedding_backfill_runs AS run
  JOIN workspaces USING (workspace_id)
  WHERE run.task_id = garden_embedding_backfill_objects.task_id
);
DELETE FROM reconciliation_leases WHERE lease_key NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);

DELETE FROM memory_entries WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM evidence_capsules WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM synthesis_capsules WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM claim_forms WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM proposals WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM karma_events WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM green_statuses WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM health_journal WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM health_issue_groups WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM files WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM trust_context_delivery WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM garden_embedding_backfill_runs WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM garden_tasks WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_sweeps WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_planning WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_tail_boundaries WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_rounds WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_messages WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM host_session_containers WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM privacy_dependency_quarantine WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM preservation_capsule_revisions WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM recall_routing_key_owners WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM relation_assertion_quarantine WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_statement_relation_pending WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_statement_relation_vectors WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM retained_source_chunks WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_record_active_evidence_refs WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_lexical_progress WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_lexical_projections WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_lexical_targets WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_lexical_selections WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_lexical_generations WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_vectors WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_windows WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_text WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_targets WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_dependencies WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_roots WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_selections WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_generations WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_invalidations WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);
DELETE FROM source_index_epochs WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces WHERE workspace_id IS NOT NULL);

-- Human review carries reviewer authority without an attached agent run.
CREATE TABLE proof_effect_decisions_new (
  workspace_id                   TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  request_digest                 TEXT NOT NULL,
  schema_version                INTEGER NOT NULL CHECK (schema_version = 2),
  actor_id                       TEXT NOT NULL,
  run_id                         TEXT,
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
  CHECK (run_id IS NOT NULL OR action = 'erase'),
  PRIMARY KEY (workspace_id, request_digest)
);
INSERT INTO proof_effect_decisions_new SELECT * FROM proof_effect_decisions;
DROP TABLE proof_effect_decisions;
ALTER TABLE proof_effect_decisions_new RENAME TO proof_effect_decisions;
CREATE INDEX idx_proof_effect_decisions_delivery
  ON proof_effect_decisions(workspace_id, actor_id, run_id, delivery_id);
