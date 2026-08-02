-- Rebuildable routing projection from append-only materialization receipts.
-- It indexes ownership only; Signal proposals remain outside Memory truth.
CREATE TABLE IF NOT EXISTS recall_routing_key_owners (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  materialized_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_kind, owner_id, signal_id)
);

CREATE INDEX IF NOT EXISTS idx_recall_routing_key_owners_lookup
ON recall_routing_key_owners(workspace_id, owner_id, owner_kind, signal_id);

INSERT OR IGNORE INTO recall_routing_key_owners (
  workspace_id, owner_id, owner_kind, signal_id, materialized_at
)
SELECT
  event.workspace_id,
  json_extract(created.value, '$.object_id'),
  json_extract(created.value, '$.object_kind'),
  event.entity_id,
  event.created_at
FROM event_log AS event, json_each(event.payload_json, '$.created_objects') AS created
WHERE event.event_type = 'soul.signal.materialized'
  AND event.entity_type = 'candidate_memory_signal'
  AND json_extract(event.payload_json, '$.success') = 1
  AND json_type(created.value, '$.object_id') = 'text'
  AND json_extract(created.value, '$.object_id') != ''
  AND json_type(created.value, '$.object_kind') = 'text'
  AND json_extract(created.value, '$.object_kind') != '';

CREATE TRIGGER IF NOT EXISTS recall_routing_key_owners_ai
AFTER INSERT ON event_log
WHEN new.event_type = 'soul.signal.materialized'
  AND new.entity_type = 'candidate_memory_signal'
  AND json_valid(new.payload_json)
  AND json_extract(new.payload_json, '$.success') = 1
BEGIN
  INSERT OR IGNORE INTO recall_routing_key_owners (
    workspace_id, owner_id, owner_kind, signal_id, materialized_at
  )
  SELECT
    new.workspace_id,
    json_extract(created.value, '$.object_id'),
    json_extract(created.value, '$.object_kind'),
    new.entity_id,
    new.created_at
  FROM json_each(new.payload_json, '$.created_objects') AS created
  WHERE json_type(created.value, '$.object_id') = 'text'
    AND json_extract(created.value, '$.object_id') != ''
    AND json_type(created.value, '$.object_kind') = 'text'
    AND json_extract(created.value, '$.object_kind') != '';
END;
