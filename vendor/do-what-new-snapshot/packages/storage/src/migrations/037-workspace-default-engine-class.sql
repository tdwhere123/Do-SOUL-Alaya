ALTER TABLE workspaces ADD COLUMN default_engine_class TEXT
  CHECK (
    default_engine_class IN ('coding_engine', 'conversation_engine')
    OR default_engine_class IS NULL
  );
