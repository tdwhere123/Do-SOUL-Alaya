ALTER TABLE temporal_schema_state
ADD COLUMN projection_refresh_required INTEGER NOT NULL DEFAULT 0
  CHECK (projection_refresh_required IN (0, 1));
