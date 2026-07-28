CREATE TABLE IF NOT EXISTS evidence_recall_embeddings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  owner_object_id TEXT NOT NULL REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  document_identity TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  document_role TEXT NOT NULL CHECK (document_role = 'evidence_document'),
  provider_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  embedding_blob BLOB NOT NULL,
  vector_valid INTEGER NOT NULL DEFAULT 1 CHECK (vector_valid IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id,
    owner_object_id,
    document_identity,
    document_role
  )
);

CREATE INDEX IF NOT EXISTS idx_evidence_recall_embeddings_lookup
  ON evidence_recall_embeddings (
    workspace_id,
    provider_kind,
    model_id,
    schema_version,
    document_role
  );
