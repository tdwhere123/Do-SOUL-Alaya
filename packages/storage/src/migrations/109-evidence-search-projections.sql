CREATE TABLE IF NOT EXISTS evidence_search_projections (
  evidence_object_id TEXT NOT NULL,
  projection_id INTEGER NOT NULL CHECK (projection_id > 0),
  projection_kind TEXT NOT NULL CHECK (projection_kind = 'user_assertion'),
  workspace_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  PRIMARY KEY (evidence_object_id, projection_id),
  FOREIGN KEY (evidence_object_id) REFERENCES evidence_capsules(object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_search_projections_workspace_owner
  ON evidence_search_projections(workspace_id, evidence_object_id);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_search_projection_fts USING fts5(
  evidence_object_id UNINDEXED,
  projection_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_search_projection_fts_trigram USING fts5(
  evidence_object_id UNINDEXED,
  projection_id UNINDEXED,
  workspace_id,
  content,
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS evidence_search_projection_fts_ai
AFTER INSERT ON evidence_search_projections
BEGIN
  INSERT INTO evidence_search_projection_fts (
    rowid, evidence_object_id, projection_id, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.workspace_id, new.content
  );
  INSERT INTO evidence_search_projection_fts_trigram (
    rowid, evidence_object_id, projection_id, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.workspace_id, new.content
  );
END;

CREATE TRIGGER IF NOT EXISTS evidence_search_projection_fts_ad
AFTER DELETE ON evidence_search_projections
BEGIN
  DELETE FROM evidence_search_projection_fts WHERE rowid = old.rowid;
  DELETE FROM evidence_search_projection_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS evidence_search_projection_fts_au
AFTER UPDATE OF evidence_object_id, projection_id, workspace_id, content
ON evidence_search_projections
BEGIN
  DELETE FROM evidence_search_projection_fts WHERE rowid = old.rowid;
  INSERT INTO evidence_search_projection_fts (
    rowid, evidence_object_id, projection_id, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.workspace_id, new.content
  );
  DELETE FROM evidence_search_projection_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO evidence_search_projection_fts_trigram (
    rowid, evidence_object_id, projection_id, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.workspace_id, new.content
  );
END;
