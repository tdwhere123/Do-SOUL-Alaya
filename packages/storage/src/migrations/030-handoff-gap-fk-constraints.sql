PRAGMA foreign_keys = OFF;

ALTER TABLE handoff_records RENAME TO handoff_records_old;
CREATE TABLE handoff_records (
  runtime_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'handoff_record',
  task_surface_ref TEXT,
  expires_at TEXT,
  derived_from TEXT,
  retention_policy TEXT NOT NULL DEFAULT 'run_scoped',
  handoff_kind TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  target_run_id TEXT,
  surface_id TEXT,
  ttl_ms INTEGER,
  recurrence_runs INTEGER,
  recurrence_surfaces INTEGER,
  governance_impact REAL,
  unresolved_age_ms INTEGER,
  upgrade_candidate INTEGER
);
INSERT INTO handoff_records SELECT * FROM handoff_records_old;
DROP TABLE handoff_records_old;
CREATE INDEX IF NOT EXISTS idx_handoff_records_source_run ON handoff_records(source_run_id);
CREATE INDEX IF NOT EXISTS idx_handoff_records_expires ON handoff_records(expires_at);

ALTER TABLE gap_records RENAME TO gap_records_old;
CREATE TABLE gap_records (
  runtime_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'gap_record',
  task_surface_ref TEXT,
  expires_at TEXT,
  derived_from TEXT,
  retention_policy TEXT NOT NULL DEFAULT 'run_scoped',
  gap_kind TEXT NOT NULL,
  detected_in_run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  surface_id TEXT,
  description TEXT NOT NULL,
  ttl_ms INTEGER,
  recurrence_runs INTEGER,
  recurrence_surfaces INTEGER,
  governance_impact REAL,
  unresolved_age_ms INTEGER,
  upgrade_candidate INTEGER
);
INSERT INTO gap_records SELECT * FROM gap_records_old;
DROP TABLE gap_records_old;
CREATE INDEX IF NOT EXISTS idx_gap_records_detected_run ON gap_records(detected_in_run_id);
CREATE INDEX IF NOT EXISTS idx_gap_records_expires ON gap_records(expires_at);

PRAGMA foreign_keys = ON;
