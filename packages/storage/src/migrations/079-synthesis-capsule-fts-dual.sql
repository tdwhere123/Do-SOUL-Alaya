-- Multilingual dual-index FTS for synthesis_capsules.summary.
--
-- Two lanes, as in migrations 077 (memory_entries) and 078
-- (evidence_capsules): 'porter unicode61' for English word-level BM25 with
-- stemming, 'trigram' for script-agnostic / CJK substring matching that
-- unicode61 cannot tokenize. Both index `summary`; the repo routes query
-- tokens across both lanes and merges by rank.
--
-- invariant: FTS5 built-in tokenizers only — no native dependency (ICU is
-- unavailable in this better-sqlite3 build and FTS5 has no `icu` tokenizer).

CREATE VIRTUAL TABLE IF NOT EXISTS synthesis_capsule_fts USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS synthesis_capsule_fts_trigram USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, summary
FROM synthesis_capsules;

INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
SELECT rowid, object_id, workspace_id, summary
FROM synthesis_capsules;

CREATE TRIGGER IF NOT EXISTS synthesis_capsule_fts_ai
AFTER INSERT ON synthesis_capsules
BEGIN
  INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
  INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS synthesis_capsule_fts_ad
AFTER DELETE ON synthesis_capsules
BEGIN
  DELETE FROM synthesis_capsule_fts WHERE rowid = old.rowid;
  DELETE FROM synthesis_capsule_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS synthesis_capsule_fts_au
AFTER UPDATE OF object_id, workspace_id, summary ON synthesis_capsules
BEGIN
  DELETE FROM synthesis_capsule_fts WHERE rowid = old.rowid;
  INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
  DELETE FROM synthesis_capsule_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
END;
