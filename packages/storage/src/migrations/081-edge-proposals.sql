CREATE TABLE IF NOT EXISTS edge_proposals (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  source_memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT,
  source_signal_id TEXT,
  run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'auto_accepted')),
  reviewer_identity TEXT,
  review_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  CHECK (source_memory_id <> target_memory_id)
);

CREATE INDEX IF NOT EXISTS idx_edge_proposals_workspace_status
  ON edge_proposals(workspace_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_edge_proposals_filter
  ON edge_proposals(workspace_id, status, edge_type, trigger_source, confidence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_proposals_pending_unique
  ON edge_proposals(workspace_id, source_memory_id, target_memory_id, edge_type)
  WHERE status = 'pending';
