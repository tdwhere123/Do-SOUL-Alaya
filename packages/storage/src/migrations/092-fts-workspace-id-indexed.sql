-- Make workspace_id an INDEXED FTS column on every content FTS table so recall
-- can scope the MATCH to one workspace (workspace_id:"<ws>" AND (terms)) instead
-- of scanning the whole index for the terms and post-filtering workspace_id.
-- With workspace_id UNINDEXED the MATCH was O(total DB content) per query (6 FTS
-- tables ~= 596ms at 96k rows); scoped it is O(workspace) (~15x faster, identical
-- rows). Rebuild is content-preserving (copy rows out, recreate with the same
-- tokenizer minus UNINDEXED, copy back, preserving rowid so the ON memory_entries
-- /capsules triggers keep deleting/inserting by rowid). The triggers live on the
-- source tables, not the FTS tables, so DROP TABLE <fts> leaves them intact.

CREATE TEMP TABLE _mig_mcf AS SELECT rowid AS rid, object_id, workspace_id, content FROM memory_content_fts;
DROP TABLE memory_content_fts;
CREATE VIRTUAL TABLE memory_content_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');
INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_mcf;
DROP TABLE _mig_mcf;

CREATE TEMP TABLE _mig_mcfp AS SELECT rowid AS rid, object_id, workspace_id, content FROM memory_content_fts_porter;
DROP TABLE memory_content_fts_porter;
CREATE VIRTUAL TABLE memory_content_fts_porter USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');
INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_mcfp;
DROP TABLE _mig_mcfp;

CREATE TEMP TABLE _mig_ecf AS SELECT rowid AS rid, object_id, workspace_id, content FROM evidence_capsule_fts;
DROP TABLE evidence_capsule_fts;
CREATE VIRTUAL TABLE evidence_capsule_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');
INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_ecf;
DROP TABLE _mig_ecf;

CREATE TEMP TABLE _mig_ecft AS SELECT rowid AS rid, object_id, workspace_id, content FROM evidence_capsule_fts_trigram;
DROP TABLE evidence_capsule_fts_trigram;
CREATE VIRTUAL TABLE evidence_capsule_fts_trigram USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');
INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_ecft;
DROP TABLE _mig_ecft;

CREATE TEMP TABLE _mig_scf AS SELECT rowid AS rid, object_id, workspace_id, content FROM synthesis_capsule_fts;
DROP TABLE synthesis_capsule_fts;
CREATE VIRTUAL TABLE synthesis_capsule_fts USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'porter unicode61');
INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_scf;
DROP TABLE _mig_scf;

CREATE TEMP TABLE _mig_scft AS SELECT rowid AS rid, object_id, workspace_id, content FROM synthesis_capsule_fts_trigram;
DROP TABLE synthesis_capsule_fts_trigram;
CREATE VIRTUAL TABLE synthesis_capsule_fts_trigram USING fts5(object_id UNINDEXED, workspace_id, content, tokenize = 'trigram');
INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content) SELECT rid, object_id, workspace_id, content FROM _mig_scft;
DROP TABLE _mig_scft;
