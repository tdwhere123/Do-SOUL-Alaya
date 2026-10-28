-- Periodic work represents the latest needed scan, not one durable job per tick.
CREATE UNIQUE INDEX garden_tasks_one_pending_periodic_kind
ON garden_tasks (workspace_id, kind)
WHERE status IN ('pending', 'claimed') AND json_valid(payload_json)
  AND json_extract(payload_json, '$.periodic') = 1;
