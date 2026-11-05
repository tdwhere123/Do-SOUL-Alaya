-- Completion is per source receipt. Ordinary workspace activity cannot reopen
-- unrelated historical closures. Dirty writes name the exact attributable root.
CREATE TABLE source_erase_closure_progress (
  workspace_id TEXT NOT NULL,
  barrier_id TEXT NOT NULL,
  data_revision INTEGER NOT NULL DEFAULT 0,
  checked_revision INTEGER NOT NULL DEFAULT -1,
  rule_version INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
  PRIMARY KEY (workspace_id, barrier_id),
  FOREIGN KEY (workspace_id, barrier_id) REFERENCES projection_erase_barriers(workspace_id, barrier_id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO source_erase_closure_progress(workspace_id, barrier_id)
  SELECT workspace_id, barrier_id FROM projection_erase_barriers WHERE subject_kind = 'source_record';
CREATE INDEX idx_source_erase_recovery_version ON source_erase_closure_progress(rule_version, workspace_id, barrier_id);
CREATE INDEX idx_source_erase_recovery_dirty ON source_erase_closure_progress(workspace_id, barrier_id) WHERE dirty = 1;
CREATE INDEX idx_source_erase_recovery_subject ON projection_erase_barriers(workspace_id, subject_kind, subject_id);
CREATE INDEX idx_host_session_pending_rounds ON host_session_rounds(workspace_id, container_key, round_index)
  WHERE state IN ('pending', 'erased_pending');
-- Recovery status must not count the entire backlog on every bounded capture.
ALTER TABLE host_session_containers ADD COLUMN pending_round_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_round_count >= 0);
UPDATE host_session_containers AS c SET pending_round_count = (SELECT COUNT(*) FROM host_session_rounds r
  WHERE r.workspace_id = c.workspace_id AND r.container_key = c.container_key AND r.state IN ('pending', 'erased_pending'));
DROP TRIGGER host_session_message_container_insert;
CREATE TRIGGER host_session_message_container_insert AFTER INSERT ON host_session_messages BEGIN
  INSERT INTO host_session_containers(workspace_id, container_key, producer, newest_position, newest_admitted_at)
    VALUES (NEW.workspace_id, NEW.container_key, NEW.producer, NEW.position, NEW.admitted_at)
  ON CONFLICT(workspace_id, container_key) DO UPDATE SET
    newest_position = MAX(newest_position, excluded.newest_position),
    newest_admitted_at = MAX(newest_admitted_at, excluded.newest_admitted_at);
END;
CREATE TRIGGER host_session_pending_round_insert AFTER INSERT ON host_session_rounds
WHEN NEW.state IN ('pending', 'erased_pending') BEGIN
  UPDATE host_session_containers SET pending_round_count = pending_round_count + 1
    WHERE workspace_id = NEW.workspace_id AND container_key = NEW.container_key;
END;
CREATE TRIGGER host_session_pending_round_update AFTER UPDATE OF state, workspace_id, container_key ON host_session_rounds BEGIN
  UPDATE host_session_containers SET pending_round_count = pending_round_count - (OLD.state IN ('pending', 'erased_pending'))
    WHERE workspace_id = OLD.workspace_id AND container_key = OLD.container_key;
  UPDATE host_session_containers SET pending_round_count = pending_round_count + (NEW.state IN ('pending', 'erased_pending'))
    WHERE workspace_id = NEW.workspace_id AND container_key = NEW.container_key;
END;
CREATE TRIGGER host_session_pending_round_delete AFTER DELETE ON host_session_rounds
WHEN OLD.state IN ('pending', 'erased_pending') BEGIN
  UPDATE host_session_containers SET pending_round_count = pending_round_count - 1
    WHERE workspace_id = OLD.workspace_id AND container_key = OLD.container_key;
END;
-- Suppression is never committed as active: its writer transaction also owns the
-- scrub and completion records. Another writer sees only the committed zero.
CREATE TABLE source_erase_repair_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  repairing INTEGER NOT NULL DEFAULT 0 CHECK (repairing IN (0, 1))
);
INSERT INTO source_erase_repair_control VALUES (1, 0);
CREATE TRIGGER source_erase_recovery_barrier_insert AFTER INSERT ON projection_erase_barriers
WHEN NEW.subject_kind = 'source_record' BEGIN
  INSERT INTO source_erase_closure_progress(workspace_id, barrier_id) VALUES (NEW.workspace_id, NEW.barrier_id);
END;
CREATE TRIGGER source_erase_recovery_source_records_insert AFTER INSERT ON source_records
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id UNION SELECT value FROM json_each(CASE WHEN json_valid(NEW.source_representation_json) AND json_extract(NEW.source_representation_json, '$.kind') = 'canonical_projection' THEN NEW.source_representation_json ELSE '{}' END, '$.source_record_ids')));
END;
CREATE TRIGGER source_erase_recovery_source_records_update AFTER UPDATE ON source_records
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id UNION SELECT value FROM json_each(CASE WHEN json_valid(NEW.source_representation_json) AND json_extract(NEW.source_representation_json, '$.kind') = 'canonical_projection' THEN NEW.source_representation_json ELSE '{}' END, '$.source_record_ids')));
END;
CREATE TRIGGER source_erase_recovery_source_record_evidence_refs_insert AFTER INSERT ON source_record_evidence_refs
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_source_record_evidence_refs_update AFTER UPDATE ON source_record_evidence_refs
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_source_statement_dependencies_insert AFTER INSERT ON source_statement_dependencies
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_source_statement_dependencies_update AFTER UPDATE ON source_statement_dependencies
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_source_host_inventories_insert AFTER INSERT ON source_host_inventories
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_source_host_inventories_update AFTER UPDATE ON source_host_inventories
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.record_id));
END;
CREATE TRIGGER source_erase_recovery_host_session_messages_insert AFTER INSERT ON host_session_messages
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.round_root_id));
END;
CREATE TRIGGER source_erase_recovery_host_session_messages_update AFTER UPDATE ON host_session_messages
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.round_root_id));
END;
CREATE TRIGGER source_erase_recovery_host_session_rounds_insert AFTER INSERT ON host_session_rounds
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.root_id));
END;
CREATE TRIGGER source_erase_recovery_host_session_rounds_update AFTER UPDATE ON host_session_rounds
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT NEW.root_id));
END;
CREATE TRIGGER source_erase_recovery_evidence_capsules_insert AFTER INSERT ON evidence_capsules
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT json_extract(NEW.gist, '$.source_target.root_id') WHERE json_valid(NEW.gist) AND json_extract(NEW.gist, '$.source_target.workspace_id') = NEW.workspace_id AND json_extract(NEW.gist, '$.source_target.root_kind') = 'source_record' UNION SELECT record_id FROM source_record_evidence_refs WHERE workspace_id = NEW.workspace_id AND evidence_object_id = NEW.object_id UNION SELECT record_id FROM source_statement_dependencies WHERE workspace_id = NEW.workspace_id AND artifact_id = NEW.object_id UNION SELECT record_id FROM source_records WHERE workspace_id = NEW.workspace_id AND evidence_object_id = NEW.object_id
          UNION SELECT source.record_id FROM source_records source JOIN event_log event
            ON event.workspace_id = source.workspace_id AND event.entity_type = 'evidence_capsule'
              AND event.event_type = 'source.interpretation.invalidated' AND event.entity_id = NEW.object_id
              AND CASE WHEN json_valid(event.payload_json) THEN
                json_extract(event.payload_json, '$.source.source_id') = source.source_id
                AND json_extract(event.payload_json, '$.source.source_version') = source.source_version
                AND json_extract(event.payload_json, '$.source.content_digest') = source.content_digest ELSE 0 END
            WHERE source.workspace_id = NEW.workspace_id));
END;
CREATE TRIGGER source_erase_recovery_evidence_capsules_update AFTER UPDATE ON evidence_capsules
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT json_extract(NEW.gist, '$.source_target.root_id') WHERE json_valid(NEW.gist) AND json_extract(NEW.gist, '$.source_target.workspace_id') = NEW.workspace_id AND json_extract(NEW.gist, '$.source_target.root_kind') = 'source_record' UNION SELECT record_id FROM source_record_evidence_refs WHERE workspace_id = NEW.workspace_id AND evidence_object_id = NEW.object_id UNION SELECT record_id FROM source_statement_dependencies WHERE workspace_id = NEW.workspace_id AND artifact_id = NEW.object_id UNION SELECT record_id FROM source_records WHERE workspace_id = NEW.workspace_id AND evidence_object_id = NEW.object_id
          UNION SELECT source.record_id FROM source_records source JOIN event_log event
            ON event.workspace_id = source.workspace_id AND event.entity_type = 'evidence_capsule'
              AND event.event_type = 'source.interpretation.invalidated' AND event.entity_id = NEW.object_id
              AND CASE WHEN json_valid(event.payload_json) THEN
                json_extract(event.payload_json, '$.source.source_id') = source.source_id
                AND json_extract(event.payload_json, '$.source.source_version') = source.source_version
                AND json_extract(event.payload_json, '$.source.content_digest') = source.content_digest ELSE 0 END
            WHERE source.workspace_id = NEW.workspace_id));
END;
CREATE TRIGGER source_erase_recovery_event_log_insert AFTER INSERT ON event_log
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT record_id FROM source_records WHERE workspace_id = NEW.workspace_id AND NEW.event_type = 'source.interpretation.invalidated' AND CASE WHEN json_valid(NEW.payload_json) THEN source_id = json_extract(NEW.payload_json, '$.source.source_id') AND source_version = json_extract(NEW.payload_json, '$.source.source_version') AND content_digest = json_extract(NEW.payload_json, '$.source.content_digest') ELSE 0 END));
END;
CREATE TRIGGER source_erase_recovery_event_log_update AFTER UPDATE ON event_log
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton = 1) = 0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision = data_revision + 1, dirty = 1
    WHERE workspace_id = NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
        AND subject_kind = 'source_record' AND subject_id IN (SELECT record_id FROM source_records WHERE workspace_id = NEW.workspace_id AND NEW.event_type = 'source.interpretation.invalidated' AND CASE WHEN json_valid(NEW.payload_json) THEN source_id = json_extract(NEW.payload_json, '$.source.source_id') AND source_version = json_extract(NEW.payload_json, '$.source.source_version') AND content_digest = json_extract(NEW.payload_json, '$.source.content_digest') ELSE 0 END));
END;
