-- Protocol 29: BM25 corpus statistics belong to a lexical generation, not retained history.
-- The transactional data migration creates both FTS lanes from existing projections.
DROP TRIGGER source_lexical_projection_insert;
DROP TRIGGER source_lexical_projection_delete;
DROP TRIGGER source_lexical_projection_update;
DROP TABLE source_index_lexical_fts;
CREATE TRIGGER source_lexical_projection_delete AFTER DELETE ON source_index_lexical_projections BEGIN
  UPDATE source_index_lexical_targets SET complete=0
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;
CREATE TRIGGER source_lexical_projection_update AFTER UPDATE ON source_index_lexical_projections BEGIN
  UPDATE source_index_lexical_targets SET complete=0 WHERE
    (workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key) OR
    (workspace_id=NEW.workspace_id AND generation_id=NEW.generation_id AND root_key=NEW.root_key);
END;
CREATE INDEX idx_source_lexical_retired ON source_index_lexical_generations(workspace_id,status,generation_id);
