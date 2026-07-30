-- Prefer gist (searchable corpus) over narrow display excerpt for evidence FTS.
-- Display atomicity stays on evidence_capsules.excerpt; distilled facts must not
-- starve the index when both columns are non-null.

DROP TRIGGER IF EXISTS evidence_capsule_fts_ai;
DROP TRIGGER IF EXISTS evidence_capsule_fts_ad;
DROP TRIGGER IF EXISTS evidence_capsule_fts_au;

DELETE FROM evidence_capsule_fts;
DELETE FROM evidence_capsule_fts_trigram;

INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, COALESCE(gist, excerpt)
FROM evidence_capsules;

INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, COALESCE(gist, excerpt)
FROM evidence_capsules;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_ai
AFTER INSERT ON evidence_capsules
BEGIN
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
END;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_ad
AFTER DELETE ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
  DELETE FROM evidence_capsule_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_au
AFTER UPDATE OF object_id, workspace_id, excerpt, gist ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
  DELETE FROM evidence_capsule_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
END;
