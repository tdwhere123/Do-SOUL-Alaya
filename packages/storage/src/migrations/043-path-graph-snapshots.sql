CREATE TABLE path_graph_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  metrics_json    TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL
);

CREATE INDEX idx_snapshots_workspace_time
  ON path_graph_snapshots(workspace_id, snapshot_at DESC);
