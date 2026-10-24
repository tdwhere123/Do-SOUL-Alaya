-- Expanded retained-root universe is a new preparation contract. Preserve historical
-- record identities and payloads, but never serve their old exhaustive generations.
ALTER TABLE source_index_generations ADD COLUMN preparation_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE source_index_generations ADD COLUMN records_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_index_generations ADD COLUMN after_capsule_cursor TEXT;
UPDATE source_index_generations SET status='retired',reason='retained_root_universe_changed';
UPDATE source_index_selections SET selection_revision=selection_revision+1,active_generation_id=NULL;

DROP VIEW source_index_affected_roots;
DROP TRIGGER source_index_invalidate;
DROP TRIGGER source_records_index_insert;
DROP TRIGGER source_records_index_delete;
DROP TRIGGER source_records_index_update;
DROP TRIGGER source_erase_index_barrier;
DROP TABLE source_index_invalidations;
CREATE TABLE source_index_roots_expanded (
  workspace_id TEXT NOT NULL, root_key TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('source_record','evidence_capsule')),
  record_id TEXT NOT NULL, source_id TEXT, target_json TEXT NOT NULL,
  CHECK((root_kind='evidence_capsule' AND source_id IS NULL) OR (root_kind='source_record' AND source_id IS NOT NULL)),
  PRIMARY KEY(workspace_id,root_key)
);
INSERT INTO source_index_roots_expanded SELECT workspace_id,root_key,'source_record',record_id,source_id,target_json FROM source_index_roots;
DROP TABLE source_index_roots;
ALTER TABLE source_index_roots_expanded RENAME TO source_index_roots;
CREATE INDEX idx_source_index_roots_record ON source_index_roots(workspace_id,root_kind,record_id);
CREATE INDEX idx_source_index_roots_source ON source_index_roots(workspace_id,root_kind,source_id);
CREATE TABLE source_index_dependencies_expanded (
  workspace_id TEXT NOT NULL, root_key TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('source_record','evidence_capsule')),
  dependency_record_id TEXT NOT NULL, dependency_source_id TEXT,
  PRIMARY KEY(workspace_id,root_key,dependency_kind,dependency_record_id)
);
INSERT INTO source_index_dependencies_expanded
  SELECT workspace_id,root_key,'source_record',dependency_record_id,dependency_source_id FROM source_index_dependencies;
DROP TABLE source_index_dependencies;
ALTER TABLE source_index_dependencies_expanded RENAME TO source_index_dependencies;
CREATE INDEX idx_source_index_dependency_record ON source_index_dependencies(workspace_id,dependency_kind,dependency_record_id,root_key);
CREATE INDEX idx_source_index_dependency_source ON source_index_dependencies(workspace_id,dependency_kind,dependency_source_id,root_key);
CREATE VIEW source_index_affected_roots AS
  SELECT workspace_id,root_key,root_kind,record_id,source_id FROM source_index_roots
  UNION ALL SELECT workspace_id,root_key,dependency_kind,dependency_record_id,dependency_source_id FROM source_index_dependencies;
CREATE TABLE source_index_invalidations (
  workspace_id TEXT NOT NULL, root_kind TEXT NOT NULL, record_id TEXT NOT NULL, source_id TEXT
);
CREATE TRIGGER source_index_invalidate AFTER INSERT ON source_index_invalidations BEGIN
  INSERT INTO source_index_epochs(workspace_id,epoch) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET epoch=epoch+1;
  UPDATE source_index_generations SET status='partial',reason='source_changed'
    WHERE workspace_id=NEW.workspace_id AND status IN ('building','partial','ready','valid_empty');
  DELETE FROM source_index_text WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_vectors WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_windows WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  UPDATE source_index_targets SET expected_windows=NULL,complete=0 WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_invalidations WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER source_records_index_insert AFTER INSERT ON source_records BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'source_record',NEW.record_id,NEW.source_id);
END;
CREATE TRIGGER source_records_index_delete AFTER DELETE ON source_records BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'source_record',OLD.record_id,OLD.source_id);
END;
CREATE TRIGGER source_records_index_update AFTER UPDATE OF
  record_id,workspace_id,source_id,source_version,content_digest,source_body,recorded_at,
  scope_class,source_representation_json,event_time,valid_from,valid_to,speaker,attribution_context_json,
  operator_id,evidence_object_id,retained_content_bytes ON source_records
WHEN OLD.record_id IS NOT NEW.record_id OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.source_id IS NOT NEW.source_id OR OLD.source_version IS NOT NEW.source_version
  OR OLD.content_digest IS NOT NEW.content_digest OR OLD.source_body IS NOT NEW.source_body
  OR OLD.recorded_at IS NOT NEW.recorded_at OR OLD.scope_class IS NOT NEW.scope_class
  OR OLD.source_representation_json IS NOT NEW.source_representation_json
  OR OLD.event_time IS NOT NEW.event_time OR OLD.valid_from IS NOT NEW.valid_from
  OR OLD.valid_to IS NOT NEW.valid_to OR OLD.speaker IS NOT NEW.speaker
  OR OLD.attribution_context_json IS NOT NEW.attribution_context_json
  OR OLD.operator_id IS NOT NEW.operator_id OR OLD.evidence_object_id IS NOT NEW.evidence_object_id
  OR OLD.retained_content_bytes IS NOT NEW.retained_content_bytes
BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'source_record',OLD.record_id,OLD.source_id);
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'source_record',NEW.record_id,NEW.source_id);
END;
CREATE TRIGGER source_erase_index_barrier AFTER INSERT ON projection_erase_barriers
WHEN NEW.subject_kind='source_record' BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'source_record',NEW.subject_id,
    (SELECT source_id FROM source_records WHERE workspace_id=NEW.workspace_id AND record_id=NEW.subject_id));
  INSERT INTO source_index_invalidations SELECT workspace_id,'evidence_capsule',evidence_object_id,NULL
    FROM source_record_evidence_refs WHERE workspace_id=NEW.workspace_id AND record_id=NEW.subject_id;
END;
-- Standalone membership changes when native active source-evidence bindings change.
CREATE TRIGGER source_active_evidence_index_insert AFTER INSERT ON source_record_active_evidence_refs BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'evidence_capsule',NEW.evidence_object_id,NULL);
END;
CREATE TRIGGER source_active_evidence_index_delete AFTER DELETE ON source_record_active_evidence_refs BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'evidence_capsule',OLD.evidence_object_id,NULL);
END;
CREATE TRIGGER evidence_capsules_index_insert AFTER INSERT ON evidence_capsules BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'evidence_capsule',NEW.object_id,NULL);
END;
CREATE TRIGGER evidence_capsules_index_delete AFTER DELETE ON evidence_capsules BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'evidence_capsule',OLD.object_id,NULL);
END;
-- Includes metadata/retained-chunk repairs without manufacturing source time or scope.
CREATE TRIGGER evidence_capsules_index_update AFTER UPDATE OF object_id,workspace_id,lifecycle_state,updated_at,
  gist,excerpt,retained_content_digest,retained_content_bytes,retained_source_event_time ON evidence_capsules
WHEN OLD.object_id IS NOT NEW.object_id OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.lifecycle_state IS NOT NEW.lifecycle_state OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.gist IS NOT NEW.gist OR OLD.excerpt IS NOT NEW.excerpt
  OR OLD.retained_content_digest IS NOT NEW.retained_content_digest OR OLD.retained_content_bytes IS NOT NEW.retained_content_bytes
  OR OLD.retained_source_event_time IS NOT NEW.retained_source_event_time
BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'evidence_capsule',OLD.object_id,NULL);
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'evidence_capsule',NEW.object_id,NULL);
END;
