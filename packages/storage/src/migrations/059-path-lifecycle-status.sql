UPDATE path_relations
SET lifecycle_json = json_set(lifecycle_json, '$.status', 'active')
WHERE json_valid(lifecycle_json) = 1
  AND json_type(lifecycle_json, '$.status') IS NULL;

UPDATE path_relations
SET lifecycle_json = json_set(lifecycle_json, '$.status', 'retired')
WHERE json_valid(lifecycle_json) = 1
  AND path_id IN (
    SELECT entity_id
    FROM event_log
    WHERE entity_type = 'path_relation'
      AND event_type = 'path.relation_retired'
  );

CREATE INDEX IF NOT EXISTS idx_event_log_workspace_type_created
  ON event_log(workspace_id, event_type, created_at);
