ALTER TABLE proof_effect_decisions RENAME TO proof_effect_decisions_v1_history;

CREATE TABLE proof_effect_decisions (
  workspace_id                   TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  request_digest                 TEXT NOT NULL,
  schema_version                INTEGER NOT NULL CHECK (schema_version = 2),
  actor_id                       TEXT NOT NULL,
  run_id                         TEXT NOT NULL,
  delivery_id                    TEXT NOT NULL,
  action                         TEXT NOT NULL,
  target                         TEXT NOT NULL,
  scope                          TEXT NOT NULL,
  effective_as_of                TEXT NOT NULL,
  decision                       TEXT NOT NULL CHECK (
    decision IN ('allow', 'deny', 'defer', 'require_confirmation')
  ),
  supporting_receipt_ids_json    TEXT NOT NULL CHECK (
    json_type(supporting_receipt_ids_json) = 'array'
  ),
  supporting_proof_witnesses_json TEXT NOT NULL CHECK (
    json_type(supporting_proof_witnesses_json) = 'array'
  ),
  governance_frontier            TEXT NOT NULL,
  policy_operator_id             TEXT NOT NULL,
  policy_operator_version        TEXT NOT NULL,
  recorded_at                    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, request_digest)
);

CREATE INDEX idx_proof_effect_decisions_delivery
  ON proof_effect_decisions(workspace_id, actor_id, run_id, delivery_id);
