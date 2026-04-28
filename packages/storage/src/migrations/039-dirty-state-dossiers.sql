CREATE TABLE IF NOT EXISTS dirty_state_dossiers (
  dossier_id TEXT PRIMARY KEY,
  worker_run_id TEXT NOT NULL,
  principal_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(
    trigger IN (
      'evidence_corruption',
      'governance_bypass',
      'state_inconsistency',
      'budget_violation',
      'safety_gate_failure',
      'manual'
    )
  ),
  panic_source TEXT NOT NULL,
  panic_summary TEXT NOT NULL,
  affected_data_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
  FOREIGN KEY (principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dirty_state_dossiers_workspace
  ON dirty_state_dossiers(workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_dirty_state_dossiers_worker_run
  ON dirty_state_dossiers(worker_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_dirty_state_dossiers_principal_run
  ON dirty_state_dossiers(principal_run_id, created_at);
