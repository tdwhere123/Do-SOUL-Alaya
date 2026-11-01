-- Statement sessions plan over a run's post-turn roots and resume after its last chunk.
CREATE INDEX idx_garden_tasks_statement_session_run ON garden_tasks(workspace_id, kind,
  (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.run_id') END))
  WHERE kind IN ('post_turn_extract', 'source_statement_session');

-- A session task names every model-visible root; none may be erased when it is queued or rewritten.
CREATE TRIGGER garden_tasks_reject_erased_session_insert
BEFORE INSERT ON garden_tasks
WHEN NEW.kind = 'source_statement_session' AND (NOT json_valid(NEW.payload_json) OR EXISTS (
  SELECT 1 FROM (
    SELECT value FROM json_each(NEW.payload_json, '$.context')
    UNION ALL SELECT value FROM json_each(NEW.payload_json, '$.targets')
  ) AS member JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = NEW.workspace_id AND barrier.subject_kind = 'source_record'
    AND barrier.subject_id = json_extract(member.value, '$.root_id')
))
BEGIN
  SELECT RAISE(ABORT, 'garden task source erased');
END;

CREATE TRIGGER garden_tasks_reject_erased_session_update
BEFORE UPDATE OF payload_json ON garden_tasks
WHEN NEW.kind = 'source_statement_session' AND (NOT json_valid(NEW.payload_json) OR EXISTS (
  SELECT 1 FROM (
    SELECT value FROM json_each(NEW.payload_json, '$.context')
    UNION ALL SELECT value FROM json_each(NEW.payload_json, '$.targets')
  ) AS member JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = NEW.workspace_id AND barrier.subject_kind = 'source_record'
    AND barrier.subject_id = json_extract(member.value, '$.root_id')
))
BEGIN
  SELECT RAISE(ABORT, 'garden task source erased');
END;
