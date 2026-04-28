CREATE TABLE IF NOT EXISTS tool_execution_records (
  execution_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by IN ('principal', 'worker')),
  requesting_principal_run_id TEXT,
  requesting_worker_run_id TEXT,
  node_id TEXT,
  governance_decision_ref TEXT NOT NULL,
  permission_result TEXT NOT NULL CHECK(permission_result IN ('allow', 'ask', 'deny')),
  executed INTEGER NOT NULL CHECK(executed IN (0, 1)),
  started_at TEXT,
  ended_at TEXT,
  result_summary TEXT,
  rollback_status TEXT NOT NULL CHECK(
    rollback_status IN ('none', 'attempted', 'succeeded', 'failed')
  ),
  post_effect_refs_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (tool_id) REFERENCES tool_specs(tool_id),
  FOREIGN KEY (requesting_principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  CHECK(
    (requested_by = 'principal' AND requesting_principal_run_id IS NOT NULL AND requesting_worker_run_id IS NULL)
    OR
    (requested_by = 'worker' AND requesting_principal_run_id IS NULL AND requesting_worker_run_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tool_execution_records_principal_requestor
  ON tool_execution_records(requesting_principal_run_id, execution_id);

CREATE INDEX IF NOT EXISTS idx_tool_execution_records_worker_requestor
  ON tool_execution_records(requesting_worker_run_id, execution_id);

CREATE INDEX IF NOT EXISTS idx_tool_execution_records_tool
  ON tool_execution_records(tool_id, started_at);
