CREATE TABLE proposal_reviewer_assignments (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(proposal_id) ON DELETE CASCADE,
  reviewer_identity TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  deadline_at TEXT,
  escalation_after_ms INTEGER CHECK (escalation_after_ms IS NULL OR escalation_after_ms >= 0)
);

CREATE INDEX idx_proposal_reviewer_assignments_reviewer_deadline
  ON proposal_reviewer_assignments(reviewer_identity, deadline_at);
