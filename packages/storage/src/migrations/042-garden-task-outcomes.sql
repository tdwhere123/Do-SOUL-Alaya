-- Older completed rows did not distinguish performed work from an intentional
-- skip. Keep their outcome unknown rather than reconstructing it from status.
ALTER TABLE garden_tasks ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('completed', 'skipped', 'failed'));
