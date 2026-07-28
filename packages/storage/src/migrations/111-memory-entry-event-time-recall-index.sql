CREATE INDEX IF NOT EXISTS idx_memory_entries_event_time_recall_active
  ON memory_entries(
    workspace_id,
    storage_tier,
    MIN(
      julianday(event_time_start),
      COALESCE(julianday(event_time_end), julianday(event_time_start))
    )
  )
  WHERE event_time_start IS NOT NULL
    AND julianday(event_time_start) IS NOT NULL
    AND (event_time_end IS NULL OR julianday(event_time_end) IS NOT NULL)
    AND COALESCE(retention_state, '') != 'tombstoned'
    AND COALESCE(lifecycle_state, '') != 'dormant';
