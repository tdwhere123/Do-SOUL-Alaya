-- This diagnostic contains no source text and commits with source admission.
CREATE TABLE source_host_capture_limitations (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'resource_limit'),
  PRIMARY KEY (workspace_id, record_id),
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE
);
