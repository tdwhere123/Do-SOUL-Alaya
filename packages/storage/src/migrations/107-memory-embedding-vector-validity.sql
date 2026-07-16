ALTER TABLE memory_embeddings
  ADD COLUMN vector_valid INTEGER NOT NULL DEFAULT 0
  CHECK (vector_valid IN (0, 1));
