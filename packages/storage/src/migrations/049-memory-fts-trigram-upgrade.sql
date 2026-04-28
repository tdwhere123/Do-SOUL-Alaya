DROP TRIGGER IF EXISTS memory_content_fts_ai;
DROP TRIGGER IF EXISTS memory_content_fts_ad;
DROP TRIGGER IF EXISTS memory_content_fts_au;

DROP TABLE IF EXISTS memory_content_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_content_fts USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, content
FROM memory_entries;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;
