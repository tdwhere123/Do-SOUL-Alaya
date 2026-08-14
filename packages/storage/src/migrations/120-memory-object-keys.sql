-- Complementary addressable Keys of memory objects. Surfaces activate
-- recall; they are not ontology truth. Evidence receipts stay on source_ref.

CREATE TABLE memory_object_keys (
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_type TEXT NOT NULL CHECK (
    key_type IN (
      'gist_remainder',
      'osf_surface',
      'osf_identity',
      'temporal_alias',
      'numeric_alias'
    )
  ),
  surface TEXT NOT NULL CHECK (length(trim(surface)) > 0),
  normalized_surface TEXT NOT NULL CHECK (length(trim(normalized_surface)) > 0),
  language TEXT CHECK (language IS NULL OR language IN ('en', 'zh', 'und')),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('evidence_gist', 'osf_factor', 'stored_text')
  ),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
  PRIMARY KEY (workspace_id, owner_id, key_id),
  FOREIGN KEY (owner_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_object_keys_owner
  ON memory_object_keys(workspace_id, owner_id, normalized_surface);

CREATE VIRTUAL TABLE memory_object_key_fts USING fts5(
  owner_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE memory_object_key_fts_trigram USING fts5(
  owner_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'trigram'
);

CREATE TRIGGER memory_object_key_fts_ai
AFTER INSERT ON memory_object_keys
BEGIN
  INSERT INTO memory_object_key_fts (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
  INSERT INTO memory_object_key_fts_trigram (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
END;

CREATE TRIGGER memory_object_key_fts_ad
AFTER DELETE ON memory_object_keys
BEGIN
  DELETE FROM memory_object_key_fts WHERE rowid = old.rowid;
  DELETE FROM memory_object_key_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_object_key_fts_au
AFTER UPDATE OF owner_id, workspace_id, surface
ON memory_object_keys
BEGIN
  DELETE FROM memory_object_key_fts WHERE rowid = old.rowid;
  INSERT INTO memory_object_key_fts (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
  DELETE FROM memory_object_key_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO memory_object_key_fts_trigram (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
END;
