CREATE TABLE IF NOT EXISTS conflict_matrix_edges (
  object_id              TEXT PRIMARY KEY,
  object_kind            TEXT NOT NULL DEFAULT 'conflict_matrix_edge',
  schema_version         INTEGER NOT NULL DEFAULT 1,
  lifecycle_state        TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL,

  source_claim_id        TEXT NOT NULL,
  target_claim_id        TEXT NOT NULL,
  edge_type              TEXT NOT NULL,

  workspace_id           TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_claim_id) REFERENCES claim_forms(object_id) ON DELETE CASCADE,
  FOREIGN KEY (target_claim_id) REFERENCES claim_forms(object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conflict_edges_source ON conflict_matrix_edges(source_claim_id);
CREATE INDEX IF NOT EXISTS idx_conflict_edges_target ON conflict_matrix_edges(target_claim_id);
CREATE INDEX IF NOT EXISTS idx_conflict_edges_workspace ON conflict_matrix_edges(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_edges_unique
  ON conflict_matrix_edges(source_claim_id, target_claim_id, edge_type);
