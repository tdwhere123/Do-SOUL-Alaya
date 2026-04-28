CREATE TABLE path_relations (
  path_id         TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  anchors_json    TEXT NOT NULL,
  constitution_json TEXT NOT NULL,
  effect_vector_json TEXT NOT NULL,
  plasticity_state_json TEXT NOT NULL,
  lifecycle_json  TEXT NOT NULL,
  legitimacy_json TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_path_relations_workspace ON path_relations(workspace_id);
CREATE INDEX idx_path_relations_updated ON path_relations(updated_at);
