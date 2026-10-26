-- Derived provenance excerpts are not new source bodies. Persist the create-time
-- role; do not infer it from source_hash or capsule text. Historical rows stay
-- independent unless rewritten through the capsule write owner.
ALTER TABLE evidence_capsules ADD COLUMN source_provenance INTEGER NOT NULL DEFAULT 0
  CHECK (source_provenance IN (0, 1));

DROP TRIGGER IF EXISTS evidence_capsules_index_update;
CREATE TRIGGER evidence_capsules_index_update AFTER UPDATE OF object_id,workspace_id,lifecycle_state,updated_at,
  gist,excerpt,retained_content_digest,retained_content_bytes,retained_source_event_time,source_provenance ON evidence_capsules
WHEN OLD.object_id IS NOT NEW.object_id OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.lifecycle_state IS NOT NEW.lifecycle_state OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.gist IS NOT NEW.gist OR OLD.excerpt IS NOT NEW.excerpt
  OR OLD.retained_content_digest IS NOT NEW.retained_content_digest OR OLD.retained_content_bytes IS NOT NEW.retained_content_bytes
  OR OLD.retained_source_event_time IS NOT NEW.retained_source_event_time
  OR OLD.source_provenance IS NOT NEW.source_provenance
BEGIN
  INSERT INTO source_index_invalidations VALUES(OLD.workspace_id,'evidence_capsule',OLD.object_id,NULL);
  INSERT INTO source_index_invalidations VALUES(NEW.workspace_id,'evidence_capsule',NEW.object_id,NULL);
END;
