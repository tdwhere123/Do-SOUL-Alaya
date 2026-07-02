CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_conflict_hot
  ON memory_entries(workspace_id, contradiction_count)
  WHERE contradiction_count > 0 AND storage_tier = 'hot';
