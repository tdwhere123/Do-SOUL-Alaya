ALTER TABLE memory_entries ADD COLUMN projection_schema_version INTEGER;
ALTER TABLE memory_entries ADD COLUMN event_time_start TEXT;
ALTER TABLE memory_entries ADD COLUMN event_time_end TEXT;
ALTER TABLE memory_entries ADD COLUMN valid_from TEXT;
ALTER TABLE memory_entries ADD COLUMN valid_to TEXT;
ALTER TABLE memory_entries ADD COLUMN time_precision TEXT;
ALTER TABLE memory_entries ADD COLUMN time_source TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_entries_event_time
  ON memory_entries(workspace_id, event_time_start, event_time_end)
  WHERE event_time_start IS NOT NULL;
