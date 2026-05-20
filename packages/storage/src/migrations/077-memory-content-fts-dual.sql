-- Multilingual dual-index FTS for memory_entries.content.
--
-- memory_content_fts (migration 049) is tokenize='trigram': script-agnostic
-- and substring/CJK-capable, but a weak English retriever (words shredded
-- into 3-grams, diluted IDF, no sub-3-char terms). This adds a SECOND FTS5
-- table tokenized with 'porter unicode61' for word-level English BM25 with
-- stemming. The trigram table is kept for CJK and substring matching; the
-- repo routes word-like Latin tokens to both and merges by best rank.
--
-- Built-in FTS5 tokenizers only (porter, unicode61) -- zero native dependency.

CREATE VIRTUAL TABLE IF NOT EXISTS memory_content_fts_porter USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

DELETE FROM memory_content_fts_porter;

INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, content
FROM memory_entries;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_porter_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_porter_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS memory_content_fts_porter_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;
