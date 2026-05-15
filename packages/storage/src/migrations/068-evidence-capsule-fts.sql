CREATE VIRTUAL TABLE IF NOT EXISTS evidence_capsule_fts USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);

DELETE FROM evidence_capsule_fts;

INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, COALESCE(excerpt, gist)
FROM evidence_capsules;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_ai
AFTER INSERT ON evidence_capsules
BEGIN
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
END;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_ad
AFTER DELETE ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_au
AFTER UPDATE OF object_id, workspace_id, excerpt, gist ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
END;
