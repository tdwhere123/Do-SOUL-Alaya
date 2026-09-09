ALTER TABLE source_records
  ADD COLUMN scope_class TEXT
  CHECK (scope_class IS NULL OR scope_class IN ('project', 'global_domain', 'global_core'));
