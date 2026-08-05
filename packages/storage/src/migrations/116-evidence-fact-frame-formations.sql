CREATE TABLE evidence_fact_frame_formations (
  evidence_object_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL CHECK (
    operator_id = 'evidence_fact_frame_formation_v1'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('formed', 'ineligible', 'unavailable', 'rejected')
  ),
  producer_operator_id TEXT,
  source_hash TEXT,
  fact_frame_json TEXT,
  capture_digest TEXT NOT NULL CHECK (
    length(capture_digest) = 71 AND
    substr(capture_digest, 1, 7) = 'sha256:'
  ),
  FOREIGN KEY (evidence_object_id)
    REFERENCES evidence_capsules(object_id) ON DELETE CASCADE,
  CHECK (
    (
      status = 'formed' AND
      producer_operator_id IS NOT NULL AND
      length(trim(producer_operator_id)) > 0 AND
      source_hash IS NOT NULL AND
      length(trim(source_hash)) > 0 AND
      fact_frame_json IS NOT NULL AND
      json_valid(fact_frame_json) AND
      json_type(fact_frame_json) = 'object'
    ) OR (
      status != 'formed' AND
      fact_frame_json IS NULL
    )
  )
);

CREATE INDEX idx_evidence_fact_frame_formations_workspace_owner
  ON evidence_fact_frame_formations(workspace_id, evidence_object_id);
