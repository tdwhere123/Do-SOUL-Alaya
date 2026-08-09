CREATE TABLE evidence_semantic_factor_formations (
  evidence_object_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL CHECK (
    operator_id = 'open_semantic_factor_formation_v1'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('formed', 'ineligible', 'unavailable', 'rejected')
  ),
  producer_operator_id TEXT,
  source_sha256 TEXT,
  graph_json TEXT,
  capture_digest TEXT NOT NULL CHECK (
    length(capture_digest) = 71 AND
    substr(capture_digest, 1, 7) = 'sha256:'
  ),
  FOREIGN KEY (evidence_object_id)
    REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  CHECK (
    source_sha256 IS NULL OR (
      length(source_sha256) = 71 AND
      substr(source_sha256, 1, 7) = 'sha256:'
    )
  ),
  CHECK (
    producer_operator_id IS NULL OR length(trim(producer_operator_id)) > 0
  ),
  CHECK (
    (
      status = 'formed' AND
      producer_operator_id IS NOT NULL AND
      source_sha256 IS NOT NULL AND
      graph_json IS NOT NULL AND
      json_valid(graph_json) AND
      json_type(graph_json) = 'object'
    ) OR (
      status != 'formed' AND
      graph_json IS NULL
    )
  )
);

CREATE INDEX idx_evidence_semantic_factor_formations_workspace_owner
  ON evidence_semantic_factor_formations(workspace_id, evidence_object_id);
