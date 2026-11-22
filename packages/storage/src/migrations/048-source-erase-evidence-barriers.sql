-- Preserve source attribution before the capsule's content and anchors are erased.
CREATE TABLE source_erase_evidence_barriers (
  workspace_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  barrier_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, evidence_id, barrier_id),
  FOREIGN KEY (workspace_id, barrier_id)
    REFERENCES projection_erase_barriers(workspace_id, barrier_id) ON DELETE CASCADE
);
