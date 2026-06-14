CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_tier_active_created
ON memory_entries(workspace_id, storage_tier, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_dimension_hot_active_created
ON memory_entries(workspace_id, dimension, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace_scope_hot_active_created
ON memory_entries(workspace_id, scope_class, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX IF NOT EXISTS idx_memory_entries_run_active_created
ON memory_entries(run_id, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';
