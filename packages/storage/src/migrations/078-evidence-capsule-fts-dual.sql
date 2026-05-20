-- evidence_capsule_fts becomes a dual-index surface.
--
-- The word-level lane (porter unicode61) gives English / space-delimited BM25
-- with Porter stemming. The substring lane (trigram) is script-agnostic and
-- recovers CJK runs that unicode61 collapses into a single token. Both lanes
-- index COALESCE(excerpt, gist), matching migration 068.
--
-- ICU is unavailable in the better-sqlite3 build and FTS5 has no `icu`
-- tokenizer; both tables use FTS5 built-in tokenizers only, so this adds no
-- native dependency.

DROP TRIGGER IF EXISTS evidence_capsule_fts_ai;
DROP TRIGGER IF EXISTS evidence_capsule_fts_ad;
DROP TRIGGER IF EXISTS evidence_capsule_fts_au;

DROP TABLE IF EXISTS evidence_capsule_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_capsule_fts USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_capsule_fts_trigram USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, COALESCE(excerpt, gist)
FROM evidence_capsules;

INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, COALESCE(excerpt, gist)
FROM evidence_capsules;

CREATE TRIGGER IF NOT EXISTS evidence_capsule_fts_ai
AFTER INSERT ON evidence_capsules
BEGIN
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
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
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
  DELETE FROM evidence_capsule_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.excerpt, new.gist));
END;
