ALTER TABLE signals
  ADD COLUMN source_memory_refs_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE signals
  ADD COLUMN supersedes_refs_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE signals
  ADD COLUMN exception_to_refs_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE signals
  ADD COLUMN contradicts_refs_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE signals
  ADD COLUMN incompatible_with_refs_json TEXT NOT NULL DEFAULT '[]';
