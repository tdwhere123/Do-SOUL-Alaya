CREATE TABLE IF NOT EXISTS worker_runs (
  worker_run_id TEXT PRIMARY KEY,
  principal_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  requesting_principal_run_id TEXT,
  requesting_worker_run_id TEXT,
  engine_class TEXT NOT NULL CHECK(engine_class IN ('coding_engine', 'conversation_engine')),
  state TEXT NOT NULL CHECK(
    state IN ('init', 'active', 'completed', 'suspended', 'aborted', 'frozen')
  ),
  subtask_description TEXT NOT NULL,
  local_surface_ref TEXT NOT NULL,
  local_evidence_pointer TEXT,
  restricted_tool_set_json TEXT NOT NULL,
  local_budget_json TEXT NOT NULL,
  agreed_return_format_json TEXT NOT NULL,
  principal_security_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  CHECK(
    (requesting_principal_run_id IS NOT NULL AND requesting_worker_run_id IS NULL)
    OR
    (requesting_principal_run_id IS NULL AND requesting_worker_run_id IS NOT NULL)
  ),
  CHECK(updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_worker_runs_principal_state
  ON worker_runs(principal_run_id, state);
