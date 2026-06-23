ALTER TABLE memory_entries
  ADD COLUMN preference_subject TEXT;

ALTER TABLE memory_entries
  ADD COLUMN preference_predicate TEXT;

ALTER TABLE memory_entries
  ADD COLUMN preference_object TEXT;

ALTER TABLE memory_entries
  ADD COLUMN preference_category TEXT;

ALTER TABLE memory_entries
  ADD COLUMN preference_polarity TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_entries_preference_profile
ON memory_entries(workspace_id, preference_subject, preference_category, preference_object)
WHERE dimension = 'preference';
