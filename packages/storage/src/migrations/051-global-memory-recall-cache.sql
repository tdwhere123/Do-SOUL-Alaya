CREATE TABLE IF NOT EXISTS global_memory_recall_cache (
  workspace_id          TEXT NOT NULL,
  global_object_id      TEXT NOT NULL,
  classification        TEXT NOT NULL CHECK (classification IN ('included', 'excluded')),
  updated_at            TEXT NOT NULL,

  PRIMARY KEY (workspace_id, global_object_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (global_object_id) REFERENCES global_memory_entries(global_object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_global_memory_recall_cache_workspace_classification
ON global_memory_recall_cache(workspace_id, classification);
