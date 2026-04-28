CREATE TABLE bootstrapping_records (
  record_id          TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL UNIQUE REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  paths_planted      INTEGER NOT NULL,
  template_ids_json  TEXT NOT NULL,
  planted_at         TEXT NOT NULL
);
