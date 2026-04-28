-- Indices required for efficient cascade deletes on run/workspace removal.
-- proposals and health_journal lack a run_id index needed when
-- deleting domain data by run_id.
CREATE INDEX IF NOT EXISTS idx_proposals_run_id
  ON proposals(run_id);

CREATE INDEX IF NOT EXISTS idx_health_journal_run_id
  ON health_journal(run_id);
