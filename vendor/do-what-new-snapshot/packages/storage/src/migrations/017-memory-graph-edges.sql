CREATE TABLE IF NOT EXISTS memory_graph_edges (
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
  UNIQUE(source_memory_id, target_memory_id, edge_type),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  FOREIGN KEY (target_memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_source
  ON memory_graph_edges(source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_target
  ON memory_graph_edges(target_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_workspace
  ON memory_graph_edges(workspace_id, edge_type);
