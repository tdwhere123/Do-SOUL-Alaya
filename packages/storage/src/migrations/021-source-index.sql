-- Source-derived projections have a separate selection and publication pointer.
-- No startup selection or inference is introduced by this migration.
CREATE TABLE source_index_epochs (
  workspace_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch >= 0)
);
CREATE TABLE source_index_selections (
  workspace_id TEXT PRIMARY KEY, selection_revision INTEGER NOT NULL,
  config_id TEXT NOT NULL, profile_id TEXT NOT NULL, configuration_json TEXT NOT NULL,
  active_generation_id TEXT
);
CREATE TABLE source_index_generations (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL,
  selection_revision INTEGER NOT NULL, config_id TEXT NOT NULL, profile_id TEXT NOT NULL,
  configuration_json TEXT NOT NULL, source_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','partial','ready','valid_empty','failed','retired')),
  enumeration_complete INTEGER NOT NULL DEFAULT 0 CHECK(enumeration_complete IN (0,1)),
  after_source_id TEXT, reason TEXT,
  target_count INTEGER NOT NULL DEFAULT 0 CHECK(target_count >= 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count >= 0 AND completed_count <= target_count),
  PRIMARY KEY(workspace_id, generation_id)
);
CREATE INDEX idx_source_index_generation_status ON source_index_generations(workspace_id,status);
CREATE TABLE source_index_roots (
  workspace_id TEXT NOT NULL, root_key TEXT NOT NULL, record_id TEXT NOT NULL,
  source_id TEXT NOT NULL, target_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id, root_key)
);
CREATE INDEX idx_source_index_roots_record ON source_index_roots(workspace_id, record_id);
CREATE INDEX idx_source_index_roots_source ON source_index_roots(workspace_id, source_id);
CREATE TABLE source_index_dependencies (
  workspace_id TEXT NOT NULL, root_key TEXT NOT NULL, dependency_record_id TEXT NOT NULL,
  dependency_source_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,root_key,dependency_record_id)
);
CREATE INDEX idx_source_index_dependency_record ON source_index_dependencies(workspace_id,dependency_record_id,root_key);
CREATE INDEX idx_source_index_dependency_source ON source_index_dependencies(workspace_id,dependency_source_id,root_key);
CREATE TABLE source_index_targets (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  expected_windows INTEGER CHECK(expected_windows >= 0 AND expected_windows <= 4096),
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  PRIMARY KEY(workspace_id, generation_id, root_key)
);
CREATE INDEX idx_source_index_target_root ON source_index_targets(workspace_id,root_key,generation_id);
-- Coverage verification admits completion; payload loss revokes it in the same transaction.
CREATE TRIGGER source_index_target_insert AFTER INSERT ON source_index_targets BEGIN
  UPDATE source_index_generations SET target_count=target_count+1
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id;
END;
CREATE TRIGGER source_index_target_delete AFTER DELETE ON source_index_targets BEGIN
  UPDATE source_index_generations SET target_count=target_count-1, completed_count=completed_count-OLD.complete
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id;
END;
CREATE TRIGGER source_index_target_completion AFTER UPDATE OF complete ON source_index_targets
WHEN OLD.complete != NEW.complete BEGIN
  UPDATE source_index_generations SET completed_count=completed_count+NEW.complete-OLD.complete
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id;
  UPDATE source_index_generations SET status='partial', reason='payload_incomplete'
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id
      AND status IN ('ready','valid_empty') AND completed_count < target_count;
END;
-- Full retained text, shared across vector profiles. Never disabled by a model switch.
CREATE TABLE source_index_text (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, root_key TEXT NOT NULL,
  content_digest TEXT NOT NULL, body_bytes INTEGER NOT NULL, body TEXT NOT NULL,
  UNIQUE(workspace_id, root_key)
);
CREATE VIRTUAL TABLE source_index_fts USING fts5(body, content='source_index_text', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER source_index_text_insert AFTER INSERT ON source_index_text BEGIN
  INSERT INTO source_index_fts(rowid,body) VALUES(NEW.id,NEW.body);
END;
CREATE TRIGGER source_index_text_delete AFTER DELETE ON source_index_text BEGIN
  INSERT INTO source_index_fts(source_index_fts,rowid,body) VALUES('delete',OLD.id,OLD.body);
END;
CREATE TRIGGER source_index_text_update AFTER UPDATE ON source_index_text BEGIN
  INSERT INTO source_index_fts(source_index_fts,rowid,body) VALUES('delete',OLD.id,OLD.body);
  INSERT INTO source_index_fts(rowid,body) VALUES(NEW.id,NEW.body);
END;
CREATE TABLE source_index_windows (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  window_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL, content_digest TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(workspace_id, generation_id, window_id),
  UNIQUE(workspace_id, generation_id, root_key, ordinal)
);
CREATE INDEX idx_source_index_windows_root ON source_index_windows(workspace_id, root_key, generation_id);
CREATE TABLE source_index_vectors (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  window_id TEXT NOT NULL, dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
  token_count INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, generation_id, window_id),
  CHECK(dimensions > 0 AND length(embedding_blob) = dimensions * 4)
);
CREATE INDEX idx_source_index_vectors_root ON source_index_vectors(workspace_id, root_key, generation_id);

-- Keep both staged and published coverage honest even if a payload row disappears.
-- Preserve the manifest so the same generation can recover by restoring payloads.
CREATE TRIGGER source_index_window_loss AFTER DELETE ON source_index_windows BEGIN
  UPDATE source_index_targets SET complete=0
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_index_vector_loss AFTER DELETE ON source_index_vectors BEGIN
  UPDATE source_index_targets SET complete=0
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_index_text_loss AFTER DELETE ON source_index_text BEGIN
  UPDATE source_index_targets SET complete=0 WHERE workspace_id=OLD.workspace_id AND root_key=OLD.root_key;
END;

-- One indexed dependency expansion serves every payload scrub, including after
-- an origin row is physically deleted (the dependency record id is retained).
CREATE VIEW source_index_affected_roots AS
  SELECT workspace_id,root_key,record_id,source_id FROM source_index_roots
  UNION ALL
  SELECT workspace_id,root_key,dependency_record_id,dependency_source_id FROM source_index_dependencies;

-- A synchronous invalidation dispatch, not a cleanup queue. All native SQL writers,
-- including erase and import, cross the same transaction-local projection barrier.
CREATE TABLE source_index_invalidations (
  workspace_id TEXT NOT NULL, record_id TEXT NOT NULL, source_id TEXT
);
CREATE TRIGGER source_index_invalidate AFTER INSERT ON source_index_invalidations BEGIN
  INSERT INTO source_index_epochs(workspace_id, epoch) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET epoch = epoch + 1;
  UPDATE source_index_generations SET status = 'partial', reason = 'source_changed'
    WHERE workspace_id = NEW.workspace_id AND status IN ('building','partial','ready','valid_empty');
  DELETE FROM source_index_text WHERE workspace_id = NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_vectors WHERE workspace_id = NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_windows WHERE workspace_id = NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  UPDATE source_index_targets SET expected_windows = NULL, complete = 0 WHERE workspace_id = NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
  DELETE FROM source_index_invalidations WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER source_records_index_insert AFTER INSERT ON source_records BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,NEW.record_id,NEW.source_id);
END;
CREATE TRIGGER source_records_index_delete AFTER DELETE ON source_records BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,OLD.record_id,OLD.source_id);
END;
-- Include read-eligibility metadata, even when a native repair keeps the gold tuple.
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
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,OLD.record_id,OLD.source_id);
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,NEW.record_id,NEW.source_id);
END;
CREATE TRIGGER source_erase_index_barrier AFTER INSERT ON projection_erase_barriers
WHEN NEW.subject_kind = 'source_record' BEGIN
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,NEW.subject_id,
    (SELECT source_id FROM source_records WHERE workspace_id = NEW.workspace_id AND record_id = NEW.subject_id));
END;
