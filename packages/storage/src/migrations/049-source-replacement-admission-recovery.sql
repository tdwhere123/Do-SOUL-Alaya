CREATE TABLE source_replacement_admission_pending (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id),
  FOREIGN KEY (workspace_id, record_id)
    REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE
);
