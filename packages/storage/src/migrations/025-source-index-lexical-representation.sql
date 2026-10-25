-- Explicit bounded preparation only. No backfill, model work, vector retirement or default cutover.
CREATE TABLE source_index_lexical_selections (
  workspace_id TEXT PRIMARY KEY, selection_revision INTEGER NOT NULL,
  representation TEXT NOT NULL CHECK(representation IN ('raw-unicode61.v1','segmented-unicode61.v1')),
  active_generation_id TEXT
);
CREATE INDEX idx_source_lexical_selection_representation ON source_index_lexical_selections(representation,active_generation_id);
CREATE TABLE source_index_lexical_generations (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL,
  selection_revision INTEGER NOT NULL, representation TEXT NOT NULL, source_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('building','partial','ready','valid_empty','failed','retired')),
  enumeration_complete INTEGER NOT NULL DEFAULT 0 CHECK(enumeration_complete IN (0,1)),
  after_source_id TEXT, after_capsule_cursor TEXT, records_complete INTEGER NOT NULL DEFAULT 0,
  reason TEXT, target_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count>=0 AND completed_count<=target_count),
  PRIMARY KEY(workspace_id,generation_id)
);
CREATE TABLE source_index_lexical_targets (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  PRIMARY KEY(workspace_id,generation_id,root_key)
);
CREATE INDEX idx_source_lexical_pending ON source_index_lexical_targets(workspace_id,generation_id,complete,root_key);
CREATE INDEX idx_source_lexical_root ON source_index_lexical_targets(workspace_id,root_key,generation_id);
CREATE TRIGGER source_lexical_target_insert AFTER INSERT ON source_index_lexical_targets BEGIN
  UPDATE source_index_lexical_generations SET target_count=target_count+1
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id;
END;
CREATE TRIGGER source_lexical_target_delete AFTER DELETE ON source_index_lexical_targets BEGIN
  UPDATE source_index_lexical_generations SET completed_count=completed_count-OLD.complete,target_count=target_count-1,
    status=CASE WHEN status IN ('ready','valid_empty') THEN 'partial' ELSE status END,reason='payload_incomplete'
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id;
END;
CREATE TRIGGER source_lexical_target_completion AFTER UPDATE OF complete ON source_index_lexical_targets
WHEN OLD.complete!=NEW.complete BEGIN
  UPDATE source_index_lexical_generations SET completed_count=completed_count+NEW.complete-OLD.complete
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id;
  UPDATE source_index_lexical_generations SET status='partial',reason='payload_incomplete'
    WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id
      AND status IN ('ready','valid_empty') AND completed_count<target_count;
END;
-- Search bytes are never evidence or embedding input. Raw trigram continues to use source_index_text.
CREATE TABLE source_index_lexical_projections (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  content_digest TEXT NOT NULL, body_bytes INTEGER NOT NULL, projection TEXT NOT NULL,
  UNIQUE(workspace_id,generation_id,root_key)
);
CREATE INDEX idx_source_lexical_projection_root ON source_index_lexical_projections(workspace_id,root_key);
CREATE VIRTUAL TABLE source_index_lexical_fts USING fts5(projection,
  content='source_index_lexical_projections',content_rowid='id',tokenize='unicode61');
CREATE TRIGGER source_lexical_projection_insert AFTER INSERT ON source_index_lexical_projections BEGIN
  INSERT INTO source_index_lexical_fts(rowid,projection) VALUES(NEW.id,NEW.projection);
END;
CREATE TRIGGER source_lexical_projection_delete AFTER DELETE ON source_index_lexical_projections BEGIN
  INSERT INTO source_index_lexical_fts(source_index_lexical_fts,rowid,projection) VALUES('delete',OLD.id,OLD.projection);
  UPDATE source_index_lexical_targets SET complete=0
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_lexical_projection_update AFTER UPDATE ON source_index_lexical_projections BEGIN
  INSERT INTO source_index_lexical_fts(source_index_lexical_fts,rowid,projection) VALUES('delete',OLD.id,OLD.projection);
  INSERT INTO source_index_lexical_fts(rowid,projection) VALUES(NEW.id,NEW.projection);
  UPDATE source_index_lexical_targets SET complete=0 WHERE
    (workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key) OR
    (workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id AND root_key=NEW.root_key);
END;
CREATE TRIGGER source_lexical_raw_loss AFTER DELETE ON source_index_text BEGIN
  DELETE FROM source_index_lexical_projections WHERE workspace_id=OLD.workspace_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_lexical_raw_change AFTER UPDATE ON source_index_text
WHEN OLD.body IS NOT NEW.body OR OLD.content_digest IS NOT NEW.content_digest OR OLD.body_bytes IS NOT NEW.body_bytes BEGIN
  DELETE FROM source_index_lexical_projections WHERE workspace_id=OLD.workspace_id AND root_key=OLD.root_key;
END;
-- BEFORE dispatch: the existing invalidation owner deletes its transient row in its AFTER trigger.
-- Reuse its exact dependency closure; even historical projections must be scrubbed.
CREATE TRIGGER source_lexical_invalidate BEFORE INSERT ON source_index_invalidations BEGIN
  UPDATE source_index_lexical_generations SET status='partial',reason='source_changed'
    WHERE workspace_id=NEW.workspace_id AND status IN ('building','partial','ready','valid_empty');
  DELETE FROM source_index_lexical_projections WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;
