CREATE TABLE soft_association_path_relations (
  path_id                   TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  anchors_json              TEXT NOT NULL CHECK (json_valid(anchors_json)),
  constitution_json         TEXT NOT NULL CHECK (json_valid(constitution_json)),
  effect_vector_json        TEXT NOT NULL CHECK (json_valid(effect_vector_json)),
  plasticity_state_json     TEXT NOT NULL CHECK (json_valid(plasticity_state_json)),
  lifecycle_json            TEXT NOT NULL CHECK (json_valid(lifecycle_json)),
  legitimacy_json           TEXT NOT NULL CHECK (json_valid(legitimacy_json)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK (json_extract(anchors_json, '$.source_anchor.kind') = 'object'),
  CHECK (json_extract(anchors_json, '$.target_anchor.kind') = 'object'),
  CHECK (json_extract(constitution_json, '$.relation_kind') = 'co_recalled'),
  CHECK (json_extract(effect_vector_json, '$.recall_bias') > 0),
  CHECK (json_extract(lifecycle_json, '$.status') = 'active'),
  CHECK (json_extract(legitimacy_json, '$.governance_class') = 'attention_only'),
  CHECK (json_array_length(json_extract(legitimacy_json, '$.evidence_basis')) = 1),
  CHECK (json_extract(legitimacy_json, '$.evidence_basis[0]') = 'recalls_edge_co_usage')
);

CREATE INDEX idx_soft_association_paths_workspace
  ON soft_association_path_relations(workspace_id, created_at, path_id);
