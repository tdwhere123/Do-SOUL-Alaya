-- Invalidation names a typed root or dependency. Identical IDs in another
-- root kind do not make its statement overlay stale.
DROP TRIGGER source_statement_relation_vector_invalidate;
CREATE TRIGGER source_statement_relation_vector_invalidate
AFTER INSERT ON source_index_invalidations BEGIN
  DELETE FROM source_statement_relation_vectors WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;

DROP TRIGGER source_statement_relation_pending_invalidate;
CREATE TRIGGER source_statement_relation_pending_invalidate
AFTER INSERT ON source_index_invalidations BEGIN
  DELETE FROM source_statement_relation_pending WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id AND root_kind=NEW.root_kind
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;

CREATE INDEX idx_source_statement_relation_vectors_root
  ON source_statement_relation_vectors(workspace_id, root_key);
CREATE INDEX idx_source_statement_relation_pending_root
  ON source_statement_relation_pending(workspace_id, root_key);

DROP INDEX idx_source_erase_recovery_subject;
