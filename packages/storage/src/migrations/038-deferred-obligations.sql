CREATE TABLE IF NOT EXISTS deferred_obligations (
  obligation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(
    kind IN ('safety_finding', 'data_cleanup', 'evidence_refresh', 'governance_pledge')
  ),
  state TEXT NOT NULL CHECK(state IN ('pending', 'fulfilled', 'expired', 'waived')),
  description TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  target_entity_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fulfilled_at TEXT,
  FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  CHECK(
    (state = 'fulfilled' AND fulfilled_at IS NOT NULL)
    OR
    (state != 'fulfilled' AND fulfilled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_deferred_obligations_run_state
  ON deferred_obligations(source_run_id, state);

CREATE INDEX IF NOT EXISTS idx_deferred_obligations_workspace_state
  ON deferred_obligations(workspace_id, state);

CREATE INDEX IF NOT EXISTS idx_deferred_obligations_state_expiry
  ON deferred_obligations(state, expires_at);
