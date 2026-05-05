ALTER TABLE proposals
ADD COLUMN proposed_changes TEXT CHECK (proposed_changes IS NULL OR json_valid(proposed_changes));
