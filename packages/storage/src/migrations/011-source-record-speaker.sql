ALTER TABLE source_records
  ADD COLUMN speaker TEXT
  CHECK (speaker IS NULL OR speaker IN ('user', 'assistant', 'system'));
