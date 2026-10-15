-- Migration execution and its ledger entry share the native migration transaction.
-- Use the same external-content ids as unicode61; mutation/erase already delete source_index_text.
CREATE VIRTUAL TABLE source_index_fts_trigram USING fts5(
  body, content='source_index_text', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER source_index_text_trigram_insert AFTER INSERT ON source_index_text BEGIN
  INSERT INTO source_index_fts_trigram(rowid,body) VALUES(NEW.id,NEW.body);
END;
CREATE TRIGGER source_index_text_trigram_delete AFTER DELETE ON source_index_text BEGIN
  INSERT INTO source_index_fts_trigram(source_index_fts_trigram,rowid,body) VALUES('delete',OLD.id,OLD.body);
END;
CREATE TRIGGER source_index_text_trigram_update AFTER UPDATE ON source_index_text BEGIN
  INSERT INTO source_index_fts_trigram(source_index_fts_trigram,rowid,body) VALUES('delete',OLD.id,OLD.body);
  INSERT INTO source_index_fts_trigram(rowid,body) VALUES(NEW.id,NEW.body);
END;
INSERT INTO source_index_fts_trigram(source_index_fts_trigram) VALUES('rebuild');
