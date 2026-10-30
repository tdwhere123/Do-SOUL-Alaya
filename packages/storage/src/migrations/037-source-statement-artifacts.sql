-- Historical signal payloads retain their original contract and read meaning.
CREATE TABLE signals_statements (
  signal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT, source TEXT NOT NULL, signal_kind TEXT NOT NULL, object_kind TEXT,
  scope_hint TEXT, domain_tags_json TEXT NOT NULL, confidence REAL,
  evidence_refs_json TEXT NOT NULL, raw_payload_json TEXT NOT NULL,
  signal_state TEXT NOT NULL DEFAULT 'emitted', created_at TEXT NOT NULL,
  source_memory_refs_json TEXT NOT NULL DEFAULT '[]', supersedes_refs_json TEXT NOT NULL DEFAULT '[]',
  exception_to_refs_json TEXT NOT NULL DEFAULT '[]', contradicts_refs_json TEXT NOT NULL DEFAULT '[]',
  incompatible_with_refs_json TEXT NOT NULL DEFAULT '[]', source_delivery_ids_json TEXT,
  source_observation_json TEXT, interpretation_contract TEXT,
  CHECK ((interpretation_contract IS NULL AND object_kind IS NOT NULL AND confidence IS NOT NULL)
    OR (interpretation_contract IS NOT NULL AND interpretation_contract IN ('source-interpretation-v1','source-statements-v1')
      AND object_kind IS NULL AND confidence IS NULL
      AND signal_kind='potential_semantic_observation' AND source='garden_compile'
      AND (interpretation_contract='source-statements-v1' OR source_observation_json IS NOT NULL)
      AND source_memory_refs_json='[]' AND supersedes_refs_json='[]'
      AND exception_to_refs_json='[]' AND contradicts_refs_json='[]' AND incompatible_with_refs_json='[]'))
);
INSERT INTO signals_statements SELECT * FROM signals;
DROP TABLE signals;
ALTER TABLE signals_statements RENAME TO signals;
CREATE INDEX idx_signals_run_id ON signals(run_id);
CREATE INDEX idx_signals_workspace_id ON signals(workspace_id);
CREATE INDEX idx_signals_source ON signals(source);
CREATE INDEX idx_signals_kind ON signals(signal_kind);

-- Re-enumerate under the expanded key-family contract. Historical rows remain inspectable.
UPDATE source_index_lexical_generations SET status='retired',reason=COALESCE(reason,'preparation_revision_changed')
WHERE status<>'retired';
UPDATE source_index_lexical_selections SET active_generation_id=NULL;

-- A key projection of an audited statement capsule, never a replacement source body.
CREATE TABLE source_statement_artifacts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  record_id TEXT NOT NULL, source_id TEXT NOT NULL,
  target_json TEXT NOT NULL, key_text TEXT NOT NULL,
  PRIMARY KEY(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,record_id) REFERENCES source_records(workspace_id,record_id) ON DELETE CASCADE
);
CREATE INDEX idx_source_statement_record ON source_statement_artifacts(workspace_id,record_id,artifact_id);
CREATE TRIGGER source_statement_key_insert AFTER INSERT ON source_statement_artifacts BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'source_record',NEW.record_id,NEW.source_id);
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'evidence_capsule',NEW.artifact_id,NULL);
END;
CREATE TRIGGER source_statement_key_delete AFTER DELETE ON source_statement_artifacts BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'source_record',OLD.record_id,OLD.source_id);
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'evidence_capsule',OLD.artifact_id,NULL);
END;
CREATE TRIGGER source_statement_key_immutable BEFORE UPDATE ON source_statement_artifacts BEGIN
  SELECT RAISE(ABORT,'statement artifacts are immutable');
END;
CREATE TRIGGER source_statement_evidence_change AFTER UPDATE OF gist,lifecycle_state ON evidence_capsules
WHEN OLD.gist IS NOT NEW.gist OR NEW.lifecycle_state<>'active' BEGIN
  DELETE FROM source_statement_artifacts WHERE workspace_id=OLD.workspace_id AND artifact_id=OLD.object_id;
END;
-- Durable provenance survives withdrawal or deletion of its source/evidence.
-- Missing dependencies must remain unavailable, not silently become independent memory.
CREATE TABLE source_statement_dependencies (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  record_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,artifact_id,record_id)
);
CREATE INDEX idx_statement_dependency_source ON source_statement_dependencies(workspace_id,record_id,artifact_id);
CREATE TABLE source_statement_memory_bindings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,memory_id)
);
CREATE TRIGGER statement_dependency_immutable BEFORE UPDATE ON source_statement_dependencies BEGIN
  SELECT RAISE(ABORT,'statement source dependencies are immutable');
END;
CREATE TRIGGER statement_memory_binding_immutable BEFORE UPDATE ON source_statement_memory_bindings BEGIN
  SELECT RAISE(ABORT,'statement memory bindings are immutable');
END;

-- One dependency projection serves the governed scrub and insert/CAS race guards.
CREATE VIEW erased_source_statement_signals AS
  SELECT s.signal_id,s.workspace_id,b.subject_id AS erased_dependency_id,b.barrier_id
  FROM signals s JOIN projection_erase_barriers b ON b.workspace_id=s.workspace_id
    AND b.subject_kind='source_record'
  WHERE s.interpretation_contract='source-statements-v1' AND CASE WHEN json_valid(s.raw_payload_json) THEN
    json_extract(s.raw_payload_json,'$.source_statement.source_root_id')=b.subject_id
    OR EXISTS (SELECT 1 FROM json_each(json_extract(s.raw_payload_json,'$.source_statement.source_context')) context
      WHERE json_extract(context.value,'$.root_id')=b.subject_id
        AND json_extract(context.value,'$.workspace_id')=s.workspace_id)
    ELSE 0 END;
CREATE TRIGGER statement_signal_erase_insert_guard AFTER INSERT ON signals
WHEN NEW.interpretation_contract='source-statements-v1' BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM erased_source_statement_signals WHERE signal_id=NEW.signal_id)
    OR json_type(NEW.raw_payload_json,'$.source_statement_unavailable') IS NOT NULL
    THEN RAISE(ABORT,'erased statement signal cannot be inserted') END;
END;
CREATE TRIGGER statement_signal_erase_update_guard AFTER UPDATE OF raw_payload_json ON signals
WHEN NEW.interpretation_contract='source-statements-v1' BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM erased_source_statement_signals WHERE signal_id=NEW.signal_id)
    OR (json_type(OLD.raw_payload_json,'$.source_statement_unavailable') IS NOT NULL AND OLD.raw_payload_json<>NEW.raw_payload_json)
    THEN RAISE(ABORT,'erased statement signal cannot be restored') END;
END;
CREATE TRIGGER source_statement_source_erased AFTER INSERT ON projection_erase_barriers
WHEN NEW.subject_kind='source_record' BEGIN
  DELETE FROM source_statement_artifacts WHERE workspace_id=NEW.workspace_id AND artifact_id IN (
    SELECT artifact_id FROM source_statement_dependencies WHERE workspace_id=NEW.workspace_id AND record_id=NEW.subject_id
  );
END;
