import { MEMORY_SOURCE_REVISION_INDEX_SQL } from "../memory-entry/source-revision.js";
import type { SqliteConnection } from "../../sqlite/db.js";
import { INDEXED_RECALL_PROJECTION_SCHEMA_SQL } from "./indexed-recall-projection-schema.js";

export const SEMANTIC_ARTIFACT_CANDIDATE_SCHEMA_REVISION = 5;

/** Explicit candidate initialization; the runtime migration ledger remains unchanged. */
export function initializeSemanticArtifactCandidateSchema(db: SqliteConnection): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS garden_semantic_schema (revision INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO garden_semantic_schema
        SELECT 5 WHERE NOT EXISTS (SELECT 1 FROM garden_semantic_schema);
      ${MEMORY_SOURCE_REVISION_INDEX_SQL};
      CREATE TABLE IF NOT EXISTS garden_semantic_artifacts (
        workspace_id TEXT NOT NULL, artifact_key TEXT NOT NULL,
        raw_json TEXT NOT NULL, payload_json TEXT NOT NULL, search_text TEXT NOT NULL, integrity TEXT NOT NULL,
        PRIMARY KEY (workspace_id, artifact_key)
      );
      CREATE TRIGGER IF NOT EXISTS garden_semantic_artifact_immutable
        BEFORE UPDATE ON garden_semantic_artifacts BEGIN
        SELECT RAISE(ABORT, 'semantic artifact is immutable'); END;
      CREATE TABLE IF NOT EXISTS garden_semantic_intents (
        workspace_id TEXT NOT NULL, object_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES garden_tasks(id),
        PRIMARY KEY(workspace_id, object_id)
      );
      CREATE TABLE IF NOT EXISTS garden_semantic_work_claims (
        workspace_id TEXT NOT NULL, artifact_key TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES garden_tasks(id),
        PRIMARY KEY(workspace_id, artifact_key)
      );
      CREATE TABLE IF NOT EXISTS garden_semantic_attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES garden_tasks(id),
        workspace_id TEXT NOT NULL, artifact_key TEXT NOT NULL, state TEXT NOT NULL
          CHECK(state IN ('dispatched','received','uncertain','not_sent')),
        raw_json TEXT, ordinal INTEGER NOT NULL, reconciliations INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_id, artifact_key, ordinal)
      );
      CREATE INDEX IF NOT EXISTS garden_semantic_attempt_lookup
        ON garden_semantic_attempts(workspace_id, artifact_key, ordinal DESC);
      CREATE TABLE IF NOT EXISTS garden_semantic_bindings (
        workspace_id TEXT NOT NULL, object_id TEXT NOT NULL,
        source_revision TEXT NOT NULL, occurrence TEXT NOT NULL,
        artifact_key TEXT NOT NULL, binding_json TEXT NOT NULL,
        PRIMARY KEY(workspace_id, object_id, source_revision, occurrence),
        FOREIGN KEY(workspace_id, artifact_key)
          REFERENCES garden_semantic_artifacts(workspace_id, artifact_key)
      );
      CREATE TABLE IF NOT EXISTS garden_semantic_projections (
        workspace_id TEXT NOT NULL, object_id TEXT NOT NULL,
        source_revision TEXT NOT NULL, publication_key TEXT NOT NULL, task_id TEXT NOT NULL, source_content TEXT NOT NULL,
        search_text TEXT NOT NULL, published_at TEXT NOT NULL,
        source_evidence_refs TEXT NOT NULL, source_updated_at TEXT NOT NULL, source_event_revision INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, object_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS garden_semantic_fts USING fts5(
        workspace_id, object_id UNINDEXED, search_text,
        tokenize = 'unicode61'
      );
      ${INDEXED_RECALL_PROJECTION_SCHEMA_SQL}
    `);
    upgradeIndexedRecallProjectionSchema(db);
    assertSemanticArtifactCandidateSchema(db);
  })();
}

export function assertSemanticArtifactCandidateSchema(db: SqliteConnection): void {
  const revisions = db.prepare("SELECT revision FROM garden_semantic_schema").all();
  const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name='garden_semantic_fts'")
    .get() as { sql: string } | undefined;
  const indexTable = db.prepare("SELECT sql FROM sqlite_master WHERE name='garden_index_revisions'")
    .get() as { sql: string } | undefined;
  if (revisions.length !== 1 || (revisions[0] as { revision: number }).revision !==
      SEMANTIC_ARTIFACT_CANDIDATE_SCHEMA_REVISION || !fts || /workspace_id\s+UNINDEXED/iu.test(fts.sql) ||
      indexTable === undefined) {
    throw new Error("incompatible semantic artifact candidate schema");
  }
}

function upgradeIndexedRecallProjectionSchema(db: SqliteConnection): void {
  const revision = (db.prepare("SELECT revision FROM garden_semantic_schema").get() as
    { revision: number } | undefined)?.revision;
  if (revision === SEMANTIC_ARTIFACT_CANDIDATE_SCHEMA_REVISION) return;
  if (revision !== 4) throw new Error("incompatible semantic artifact candidate schema");
  db.prepare("UPDATE garden_semantic_schema SET revision=5 WHERE revision=4").run();
}
