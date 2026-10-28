-- A post-turn task cannot restore copied source text after an erase barrier.
CREATE TRIGGER garden_tasks_reject_erased_source_insert
BEFORE INSERT ON garden_tasks
WHEN NEW.kind = 'post_turn_extract' AND json_valid(NEW.payload_json)
  AND json_type(NEW.payload_json, '$.turn_digest') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM projection_erase_barriers AS barrier
    WHERE barrier.workspace_id = NEW.workspace_id
      AND barrier.subject_kind = 'source_record'
      AND barrier.subject_id = json_extract(NEW.payload_json, '$.admitted_source_root_id')
  )
BEGIN
  SELECT RAISE(ABORT, 'garden task source erased');
END;

CREATE TRIGGER garden_tasks_reject_erased_source_update
BEFORE UPDATE OF payload_json ON garden_tasks
WHEN NEW.kind = 'post_turn_extract' AND json_valid(NEW.payload_json)
  AND json_type(NEW.payload_json, '$.turn_digest') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM projection_erase_barriers AS barrier
    WHERE barrier.workspace_id = NEW.workspace_id
      AND barrier.subject_kind = 'source_record'
      AND barrier.subject_id = json_extract(NEW.payload_json, '$.admitted_source_root_id')
  )
BEGIN
  SELECT RAISE(ABORT, 'garden task source erased');
END;
