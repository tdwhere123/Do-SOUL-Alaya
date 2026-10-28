-- V2 keeps bounded, restartable source-analysis units under the lexical target.
ALTER TABLE source_index_lexical_selections RENAME TO source_index_lexical_selections_v1;
CREATE TABLE source_index_lexical_selections (
  workspace_id TEXT PRIMARY KEY, selection_revision INTEGER NOT NULL,
  representation TEXT NOT NULL CHECK(representation IN ('raw-unicode61.v1','segmented-unicode61.v1','segmented-unicode61.v2')),
  active_generation_id TEXT
);
INSERT INTO source_index_lexical_selections SELECT * FROM source_index_lexical_selections_v1;
DROP TABLE source_index_lexical_selections_v1;
CREATE INDEX idx_source_lexical_selection_representation ON source_index_lexical_selections(representation,active_generation_id);

CREATE TABLE source_index_lexical_progress (
  workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL, root_key TEXT NOT NULL,
  start_byte INTEGER NOT NULL CHECK(start_byte>=0), end_byte INTEGER NOT NULL CHECK(end_byte>start_byte),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=64 AND end_byte-start_byte=length(CAST(body AS BLOB))),
  projection TEXT NOT NULL CHECK(length(CAST(projection AS BLOB))<=384),
  pending TEXT NOT NULL CHECK(length(CAST(pending AS BLOB))<=64),
  PRIMARY KEY(workspace_id,generation_id,root_key,start_byte)
);
CREATE TRIGGER source_lexical_progress_target_delete AFTER DELETE ON source_index_lexical_targets BEGIN
  DELETE FROM source_index_lexical_progress WHERE workspace_id=OLD.workspace_id
    AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_lexical_progress_generation_delete AFTER DELETE ON source_index_lexical_generations BEGIN
  DELETE FROM source_index_lexical_progress WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id;
END;
CREATE TRIGGER source_lexical_progress_invalidate BEFORE INSERT ON source_index_invalidations BEGIN
  DELETE FROM source_index_lexical_progress WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;
