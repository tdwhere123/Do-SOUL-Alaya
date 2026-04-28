CREATE TABLE IF NOT EXISTS node_instances (
  node_id TEXT PRIMARY KEY,
  principal_run_id TEXT NOT NULL,
  node_template TEXT NOT NULL CHECK(
    node_template IN ('analyze', 'plan', 'build', 'review')
  ),
  state TEXT NOT NULL CHECK(
    state IN ('pending', 'active', 'completed', 'aborted', 'frozen')
  ),
  task_surface_ref TEXT NOT NULL,
  stance_resolution_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (principal_run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  CHECK(updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_node_instances_run_state
  ON node_instances(principal_run_id, state);

CREATE INDEX IF NOT EXISTS idx_node_instances_template
  ON node_instances(node_template);
