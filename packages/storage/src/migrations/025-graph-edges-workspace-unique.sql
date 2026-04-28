-- Recreate memory_graph_edges with workspace-scoped unique constraint.
-- The original migration 017 used UNIQUE(source_memory_id, target_memory_id, edge_type)
-- which allows duplicate edges across workspaces. This migration scopes the constraint
-- to UNIQUE(source_memory_id, target_memory_id, edge_type, workspace_id).
-- SQLite does not support ALTER TABLE ADD UNIQUE, so table recreation is required.

CREATE TABLE IF NOT EXISTS memory_graph_edges_v2 (
  edge_id TEXT NOT NULL PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  edge_type TEXT NOT NULL CHECK(
    edge_type IN (
      'supports',
      'derives_from',
      'contradicts',
      'supersedes',
      'recalls',
      'exception_to',
      'incompatible_with'
    )
  ),
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_memory_id, target_memory_id, edge_type, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

-- Keep exactly one row per duplicate group (earliest by rowid = insertion order).
INSERT INTO memory_graph_edges_v2
  SELECT edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
  FROM memory_graph_edges
  WHERE rowid IN (
    SELECT MIN(rowid)
    FROM memory_graph_edges
    GROUP BY source_memory_id, target_memory_id, edge_type, workspace_id
  );

DROP TABLE memory_graph_edges;
ALTER TABLE memory_graph_edges_v2 RENAME TO memory_graph_edges;

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_source
  ON memory_graph_edges(source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_target
  ON memory_graph_edges(target_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_workspace
  ON memory_graph_edges(workspace_id, edge_type);
