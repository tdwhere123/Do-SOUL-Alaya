ALTER TABLE evidence_capsules ADD COLUMN retained_content_digest TEXT;
ALTER TABLE evidence_capsules ADD COLUMN retained_content_bytes INTEGER;
ALTER TABLE evidence_capsules ADD COLUMN retained_source_event_time TEXT;
ALTER TABLE source_records ADD COLUMN retained_content_bytes INTEGER;

CREATE TABLE retained_source_chunks (
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('source_record', 'evidence_capsule')),
  root_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  body BLOB NOT NULL CHECK (typeof(body) = 'blob' AND length(body) BETWEEN 1 AND 4096),
  body_digest TEXT NOT NULL CHECK (typeof(body_digest) = 'text' AND octet_length(body_digest) = 64),
  PRIMARY KEY (workspace_id, root_kind, root_id, source_revision, content_digest, start_offset)
) WITHOUT ROWID;

CREATE TABLE source_record_active_evidence_refs (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  evidence_object_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id, evidence_object_id)
) WITHOUT ROWID;
CREATE INDEX idx_source_record_active_evidence_capsule
  ON source_record_active_evidence_refs(evidence_object_id, workspace_id, record_id);
CREATE INDEX idx_source_record_evidence_capsule
  ON source_record_evidence_refs(evidence_object_id, workspace_id, record_id);

INSERT INTO source_record_active_evidence_refs
SELECT ref.workspace_id, ref.record_id, ref.evidence_object_id
FROM source_record_evidence_refs ref
JOIN source_records r ON r.workspace_id = ref.workspace_id AND r.record_id = ref.record_id
JOIN evidence_capsules e ON e.workspace_id = ref.workspace_id AND e.object_id = ref.evidence_object_id
WHERE r.source_body IS NOT NULL AND e.lifecycle_state = 'active';

CREATE TRIGGER source_evidence_ref_activate AFTER INSERT ON source_record_evidence_refs
BEGIN
  INSERT OR IGNORE INTO source_record_active_evidence_refs
  SELECT NEW.workspace_id, NEW.record_id, NEW.evidence_object_id
  FROM source_records r JOIN evidence_capsules e ON e.workspace_id = r.workspace_id
  WHERE r.workspace_id = NEW.workspace_id AND r.record_id = NEW.record_id AND r.source_body IS NOT NULL
    AND e.object_id = NEW.evidence_object_id AND e.lifecycle_state = 'active';
END;
CREATE TRIGGER source_evidence_ref_deactivate AFTER DELETE ON source_record_evidence_refs
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE workspace_id = OLD.workspace_id
    AND record_id = OLD.record_id AND evidence_object_id = OLD.evidence_object_id;
END;
CREATE TRIGGER source_evidence_ref_rebind AFTER UPDATE ON source_record_evidence_refs
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE workspace_id = OLD.workspace_id
    AND record_id = OLD.record_id AND evidence_object_id = OLD.evidence_object_id;
  INSERT OR IGNORE INTO source_record_active_evidence_refs
  SELECT NEW.workspace_id, NEW.record_id, NEW.evidence_object_id
  FROM source_records r JOIN evidence_capsules e ON e.workspace_id = r.workspace_id
  WHERE r.workspace_id = NEW.workspace_id AND r.record_id = NEW.record_id AND r.source_body IS NOT NULL
    AND e.object_id = NEW.evidence_object_id AND e.lifecycle_state = 'active';
END;
CREATE TRIGGER capsule_source_refs_refresh AFTER UPDATE OF lifecycle_state, workspace_id ON evidence_capsules
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE evidence_object_id = OLD.object_id;
  INSERT OR IGNORE INTO source_record_active_evidence_refs
  SELECT ref.workspace_id, ref.record_id, ref.evidence_object_id
  FROM source_record_evidence_refs ref
  JOIN source_records r ON r.workspace_id = ref.workspace_id AND r.record_id = ref.record_id
  WHERE ref.evidence_object_id = NEW.object_id AND ref.workspace_id = NEW.workspace_id
    AND NEW.lifecycle_state = 'active' AND r.source_body IS NOT NULL;
END;
CREATE TRIGGER capsule_source_refs_delete AFTER DELETE ON evidence_capsules
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE evidence_object_id = OLD.object_id;
END;
CREATE TRIGGER record_source_refs_invalidate AFTER UPDATE OF source_body ON source_records
WHEN NEW.source_body IS NULL
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE workspace_id = OLD.workspace_id AND record_id = OLD.record_id;
END;
CREATE TRIGGER record_source_refs_delete AFTER DELETE ON source_records
BEGIN
  DELETE FROM source_record_active_evidence_refs WHERE workspace_id = OLD.workspace_id AND record_id = OLD.record_id;
END;

CREATE INDEX idx_memory_embeddings_recall_profile_seek
  ON memory_embeddings(workspace_id, vector_valid, model_id, provider_kind, schema_version, object_id);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_recall_profile_identity
  ON memory_embeddings(workspace_id, provider_kind, model_id, schema_version, vector_valid, object_id);
CREATE INDEX idx_memory_embeddings_recall_query_identity
  ON memory_embeddings(workspace_id, content_hash, provider_kind, model_id, schema_version, dimensions, vector_valid, object_id);

CREATE INDEX idx_evidence_capsules_source_cursor
  ON evidence_capsules(workspace_id, created_at, object_id);
CREATE INDEX idx_source_records_evidence_root
  ON source_records(workspace_id, evidence_object_id) WHERE source_body IS NOT NULL;

-- Source hashes may describe original input; retained reductions have their
-- own write-time digest. Existing missing metadata is not repaired by Recall.
CREATE TRIGGER evidence_capsules_invalidate_retained_content
AFTER UPDATE OF gist, excerpt ON evidence_capsules
WHEN OLD.gist IS NOT NEW.gist OR OLD.excerpt IS NOT NEW.excerpt
BEGIN
  DELETE FROM retained_source_chunks WHERE workspace_id = OLD.workspace_id
    AND root_kind = 'evidence_capsule' AND root_id = OLD.object_id;
  UPDATE evidence_capsules
  SET retained_content_digest = NULL, retained_content_bytes = NULL
  WHERE object_id = NEW.object_id;
END;

CREATE TRIGGER evidence_capsules_revise_retained_chunks
AFTER UPDATE OF updated_at ON evidence_capsules
WHEN OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE retained_source_chunks SET source_revision = NEW.updated_at,
    body_digest = retained_source_chunk_digest_v1(workspace_id, root_kind, root_id, NEW.updated_at, content_digest, start_offset, body)
  WHERE workspace_id = OLD.workspace_id AND root_kind = 'evidence_capsule' AND root_id = OLD.object_id;
END;

CREATE TRIGGER evidence_capsules_delete_retained_chunks
AFTER DELETE ON evidence_capsules
BEGIN
  DELETE FROM retained_source_chunks WHERE workspace_id = OLD.workspace_id
    AND root_kind = 'evidence_capsule' AND root_id = OLD.object_id;
END;

CREATE TRIGGER source_records_invalidate_retained_chunks
AFTER UPDATE OF source_body, source_version, content_digest ON source_records
WHEN OLD.source_body IS NOT NEW.source_body OR OLD.source_version IS NOT NEW.source_version
  OR OLD.content_digest IS NOT NEW.content_digest
BEGIN
  DELETE FROM retained_source_chunks WHERE workspace_id = OLD.workspace_id
    AND root_kind = 'source_record' AND root_id = OLD.record_id;
  UPDATE source_records SET retained_content_bytes = NULL
  WHERE workspace_id = OLD.workspace_id AND record_id = OLD.record_id;
END;

CREATE TRIGGER source_records_delete_retained_chunks
AFTER DELETE ON source_records
BEGIN
  DELETE FROM retained_source_chunks WHERE workspace_id = OLD.workspace_id
    AND root_kind = 'source_record' AND root_id = OLD.record_id;
END;

CREATE TRIGGER evidence_capsules_refresh_source_event_time
AFTER UPDATE OF event_anchor ON evidence_capsules
WHEN OLD.event_anchor IS NOT NEW.event_anchor
BEGIN
  UPDATE evidence_capsules SET retained_source_event_time = json_extract(NEW.event_anchor, '$.occurred_at')
  WHERE object_id = NEW.object_id;
END;
