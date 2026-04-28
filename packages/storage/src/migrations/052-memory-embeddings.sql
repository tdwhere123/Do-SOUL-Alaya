CREATE TABLE IF NOT EXISTS memory_embeddings (
  object_id TEXT PRIMARY KEY REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_workspace
  ON memory_embeddings (workspace_id);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_workspace_provider_model
  ON memory_embeddings (workspace_id, provider_kind, model_id);
