-- v0.3.9 Cat-H.3: UpgradeAssessmentAxis was always hardcoded null at
-- creation; the computer that would populate the five fields was never
-- implemented. Drop the columns from gap_records and handoff_records.

ALTER TABLE handoff_records DROP COLUMN recurrence_runs;
ALTER TABLE handoff_records DROP COLUMN recurrence_surfaces;
ALTER TABLE handoff_records DROP COLUMN governance_impact;
ALTER TABLE handoff_records DROP COLUMN unresolved_age_ms;
ALTER TABLE handoff_records DROP COLUMN upgrade_candidate;

ALTER TABLE gap_records DROP COLUMN recurrence_runs;
ALTER TABLE gap_records DROP COLUMN recurrence_surfaces;
ALTER TABLE gap_records DROP COLUMN governance_impact;
ALTER TABLE gap_records DROP COLUMN unresolved_age_ms;
ALTER TABLE gap_records DROP COLUMN upgrade_candidate;
