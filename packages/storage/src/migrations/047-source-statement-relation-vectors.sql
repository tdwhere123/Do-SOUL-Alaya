-- Optional keyed overlay for statement-relation embeddings. Window completeness
-- and generation activation stay owned by source_index_vectors; this table must
-- not drive source_index_targets.complete.
CREATE TABLE source_statement_relation_vectors (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding_blob BLOB NOT NULL,
  token_count INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, generation_id, root_key),
  CHECK (typeof(embedding_blob) = 'blob' AND dimensions > 0 AND octet_length(embedding_blob) = dimensions * 4)
);

CREATE TRIGGER source_statement_relation_vector_generation_delete
AFTER DELETE ON source_index_generations BEGIN
  DELETE FROM source_statement_relation_vectors
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id;
END;

-- Source invalidation already retires window vectors; drop the overlay so a
-- later generation can persist a new relation digest without a conflict.
CREATE TRIGGER source_statement_relation_vector_invalidate
AFTER INSERT ON source_index_invalidations BEGIN
  DELETE FROM source_statement_relation_vectors WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;

-- Exact statement-key overlay queue. Capture inserts only when auxiliary is
-- present; LIKE matching of ordinary source_id values must never enqueue.
CREATE TABLE source_statement_relation_pending (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  PRIMARY KEY (workspace_id, generation_id, root_key)
);

CREATE TRIGGER source_statement_relation_pending_generation_delete
AFTER DELETE ON source_index_generations BEGIN
  DELETE FROM source_statement_relation_pending
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id;
END;

CREATE TRIGGER source_statement_relation_pending_target_delete
AFTER DELETE ON source_index_targets BEGIN
  DELETE FROM source_statement_relation_pending
    WHERE workspace_id=OLD.workspace_id AND generation_id=OLD.generation_id AND root_key=OLD.root_key;
END;

CREATE TRIGGER source_statement_relation_pending_invalidate
AFTER INSERT ON source_index_invalidations BEGIN
  DELETE FROM source_statement_relation_pending WHERE workspace_id=NEW.workspace_id AND root_key IN (
    SELECT root_key FROM source_index_affected_roots WHERE workspace_id=NEW.workspace_id
      AND (record_id=NEW.record_id OR source_id=NEW.source_id));
END;
