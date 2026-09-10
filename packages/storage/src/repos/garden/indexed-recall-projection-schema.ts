import type { SqliteConnection } from "../../sqlite/db.js";

const SOURCE_EVENT_REVISION_SQL = `COALESCE((SELECT revision FROM event_log
  INDEXED BY garden_semantic_source_event_revision
  WHERE workspace_id=new.workspace_id AND entity_type='memory_entry' AND entity_id=new.object_id
    AND event_type IN ('soul.memory.created','soul.memory.updated') ORDER BY revision DESC LIMIT 1),
  RAISE(ABORT, 'missing source event revision'))`;

const CURSOR_EVENT_REVISION_SQL = `COALESCE((SELECT MAX(revision) FROM event_log WHERE workspace_id=new.workspace_id), 0)`;

const TOMBSTONE_PREDICATE = `new.lifecycle_state IN ('tombstone', 'deleted') OR new.retention_state = 'tombstoned'`;

export const INDEXED_RECALL_PROJECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS garden_index_revisions (
  workspace_id TEXT NOT NULL, object_id TEXT NOT NULL,
  source_event_revision INTEGER NOT NULL,
  source_content TEXT NOT NULL, source_evidence_refs TEXT NOT NULL, source_updated_at TEXT NOT NULL,
  semantic_publication_key TEXT, embedding_content_hash TEXT,
  tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, object_id)
);
CREATE TABLE IF NOT EXISTS garden_projection_cursor (
  workspace_id TEXT PRIMARY KEY,
  applied_event_revision INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
DROP TRIGGER IF EXISTS garden_index_memory_ai;
DROP TRIGGER IF EXISTS garden_index_memory_au;
DROP TRIGGER IF EXISTS garden_index_memory_tombstone;
DROP TRIGGER IF EXISTS garden_index_memory_ad;
DROP TRIGGER IF EXISTS garden_index_semantic_ai;
DROP TRIGGER IF EXISTS garden_index_semantic_au;
DROP TRIGGER IF EXISTS garden_index_embedding_ai;
DROP TRIGGER IF EXISTS garden_index_embedding_au;
DROP TRIGGER IF EXISTS garden_index_embedding_ad;
CREATE TRIGGER garden_index_memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO garden_index_revisions (
    workspace_id, object_id, source_event_revision, source_content, source_evidence_refs,
    source_updated_at, semantic_publication_key, embedding_content_hash, tombstoned, applied_at
  ) VALUES (
    new.workspace_id, new.object_id, ${SOURCE_EVENT_REVISION_SQL},
    new.content, new.evidence_refs, new.updated_at, NULL, NULL,
    CASE WHEN ${TOMBSTONE_PREDICATE} THEN 1 ELSE 0 END, new.updated_at
  );
  INSERT INTO garden_projection_cursor(workspace_id, applied_event_revision, applied_at)
  VALUES (new.workspace_id, ${CURSOR_EVENT_REVISION_SQL}, new.updated_at)
  ON CONFLICT(workspace_id) DO UPDATE SET
    applied_event_revision = CASE WHEN excluded.applied_event_revision >
      garden_projection_cursor.applied_event_revision THEN excluded.applied_event_revision
      ELSE garden_projection_cursor.applied_event_revision END,
    applied_at = excluded.applied_at;
END;
CREATE TRIGGER garden_index_memory_au AFTER UPDATE OF content, evidence_refs, updated_at,
    lifecycle_state, retention_state ON memory_entries BEGIN
  UPDATE garden_index_revisions SET
    source_event_revision = ${SOURCE_EVENT_REVISION_SQL},
    source_content = new.content, source_evidence_refs = new.evidence_refs,
    source_updated_at = new.updated_at,
    semantic_publication_key = CASE WHEN ${TOMBSTONE_PREDICATE}
      OR new.content != old.content OR new.evidence_refs != old.evidence_refs
      OR new.updated_at != old.updated_at THEN NULL ELSE semantic_publication_key END,
    embedding_content_hash = CASE WHEN ${TOMBSTONE_PREDICATE} OR new.content != old.content
      THEN NULL ELSE embedding_content_hash END,
    tombstoned = CASE WHEN ${TOMBSTONE_PREDICATE} THEN 1 ELSE 0 END,
    applied_at = new.updated_at
  WHERE workspace_id = new.workspace_id AND object_id = new.object_id;
  INSERT INTO garden_projection_cursor(workspace_id, applied_event_revision, applied_at)
  VALUES (new.workspace_id, ${CURSOR_EVENT_REVISION_SQL}, new.updated_at)
  ON CONFLICT(workspace_id) DO UPDATE SET
    applied_event_revision = CASE WHEN excluded.applied_event_revision >
      garden_projection_cursor.applied_event_revision THEN excluded.applied_event_revision
      ELSE garden_projection_cursor.applied_event_revision END,
    applied_at = excluded.applied_at;
END;
CREATE TRIGGER garden_index_memory_tombstone AFTER UPDATE OF lifecycle_state, retention_state
    ON memory_entries
  WHEN ${TOMBSTONE_PREDICATE}
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = new.rowid;
  DELETE FROM memory_content_fts_porter WHERE rowid = new.rowid;
  DELETE FROM garden_semantic_fts WHERE workspace_id = new.workspace_id AND object_id = new.object_id;
END;
CREATE TRIGGER garden_index_memory_ad AFTER DELETE ON memory_entries BEGIN
  DELETE FROM garden_index_revisions WHERE workspace_id = old.workspace_id AND object_id = old.object_id;
  DELETE FROM garden_semantic_fts WHERE workspace_id = old.workspace_id AND object_id = old.object_id;
END;
CREATE TRIGGER garden_index_semantic_ai AFTER INSERT ON garden_semantic_projections BEGIN
  UPDATE garden_index_revisions SET semantic_publication_key = new.publication_key, applied_at = new.published_at
  WHERE workspace_id = new.workspace_id AND object_id = new.object_id AND tombstoned = 0;
END;
CREATE TRIGGER garden_index_semantic_au AFTER UPDATE OF publication_key, published_at ON garden_semantic_projections BEGIN
  UPDATE garden_index_revisions SET semantic_publication_key = new.publication_key, applied_at = new.published_at
  WHERE workspace_id = new.workspace_id AND object_id = new.object_id AND tombstoned = 0;
END;
CREATE TRIGGER garden_index_embedding_ai AFTER INSERT ON memory_embeddings BEGIN
  UPDATE garden_index_revisions SET embedding_content_hash = new.content_hash, applied_at = new.updated_at
  WHERE workspace_id = new.workspace_id AND object_id = new.object_id AND tombstoned = 0;
END;
CREATE TRIGGER garden_index_embedding_au AFTER UPDATE OF content_hash ON memory_embeddings BEGIN
  UPDATE garden_index_revisions SET embedding_content_hash = new.content_hash, applied_at = new.updated_at
  WHERE workspace_id = new.workspace_id AND object_id = new.object_id AND tombstoned = 0;
END;
CREATE TRIGGER garden_index_embedding_ad AFTER DELETE ON memory_embeddings BEGIN
  UPDATE garden_index_revisions SET embedding_content_hash = NULL
  WHERE workspace_id = old.workspace_id AND object_id = old.object_id;
END;
INSERT OR IGNORE INTO garden_index_revisions (
  workspace_id, object_id, source_event_revision, source_content, source_evidence_refs,
  source_updated_at, semantic_publication_key, embedding_content_hash, tombstoned, applied_at
)
SELECT m.workspace_id, m.object_id,
  (SELECT revision FROM event_log INDEXED BY garden_semantic_source_event_revision
    WHERE workspace_id=m.workspace_id AND entity_type='memory_entry' AND entity_id=m.object_id
      AND event_type IN ('soul.memory.created','soul.memory.updated') ORDER BY revision DESC LIMIT 1),
  m.content, m.evidence_refs, m.updated_at, p.publication_key, e.content_hash,
  CASE WHEN m.lifecycle_state IN ('tombstone', 'deleted') OR m.retention_state = 'tombstoned' THEN 1 ELSE 0 END,
  m.updated_at
FROM memory_entries m
LEFT JOIN garden_semantic_projections p ON p.workspace_id=m.workspace_id AND p.object_id=m.object_id
LEFT JOIN memory_embeddings e ON e.workspace_id=m.workspace_id AND e.object_id=m.object_id
WHERE EXISTS (
  SELECT 1 FROM event_log INDEXED BY garden_semantic_source_event_revision
  WHERE workspace_id=m.workspace_id AND entity_type='memory_entry' AND entity_id=m.object_id
    AND event_type IN ('soul.memory.created','soul.memory.updated')
);
INSERT OR IGNORE INTO garden_projection_cursor(workspace_id, applied_event_revision, applied_at)
SELECT workspace_id, MAX(source_event_revision), MAX(applied_at)
FROM garden_index_revisions GROUP BY workspace_id;
`;

/** Publication generations count observable mutations, never per-entity revisions. */
export function initializeObservableMutationGeneration(db: SqliteConnection): void {
  const columns = new Set((db.prepare("PRAGMA table_info(garden_projection_cursor)").all() as { name: string }[])
    .map((column) => column.name));
  if (!columns.has("observable_generation")) db.exec(`ALTER TABLE garden_projection_cursor
    ADD COLUMN observable_generation INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(observable_generation) = 'integer' AND observable_generation >= 0)`);
  if (!columns.has("observable_epoch")) db.exec("ALTER TABLE garden_projection_cursor ADD COLUMN observable_epoch TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE garden_projection_cursor SET observable_epoch = lower(hex(randomblob(16))) WHERE observable_epoch = ''");
  for (const table of ["memory_entries", "garden_semantic_projections", "memory_embeddings", "relation_assertions", "relation_assertion_evidence",
    "relation_assertion_resolution_current", "path_relations", "relation_path_projections", "claim_forms",
    "event_log", "source_records", "source_record_evidence_refs", "evidence_capsules"]) installMutationTriggers(db, table);
}

function installMutationTriggers(db: SqliteConnection, table: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
  const changed = columns.map((column) => {
    const quoted = column.replaceAll('"', '""');
    return `new."${quoted}" IS NOT old."${quoted}"`;
  }).join(" OR ");
  for (const [operation, suffix] of [["INSERT", "ai"], ["UPDATE", "au"], ["DELETE", "ad"]] as const) {
    const rows = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"];
    const name = `garden_observable_${table}_${suffix}`;
    const workspaces = rows.map((row) => {
      const workspace = table === "relation_assertion_evidence"
        ? `(SELECT workspace_id FROM relation_assertions WHERE assertion_id = ${row}.assertion_id)` : `${row}.workspace_id`;
      const relevant = table === "event_log"
        ? ` AND ${row}.event_type IN ('soul.memory.created', 'soul.memory.updated', 'relation.assertion_admitted', 'relation.assertion_resolved')` : "";
      return `SELECT ${workspace} AS workspace_id WHERE ${workspace} IS NOT NULL${relevant}`;
    }).join(" UNION ");
    const writes = `INSERT INTO garden_projection_cursor(workspace_id, applied_event_revision, applied_at, observable_epoch, observable_generation)
      SELECT workspace_id, 0, '1970-01-01T00:00:00.000Z', lower(hex(randomblob(16))), 1 FROM (${workspaces}) WHERE 1
      ON CONFLICT(workspace_id) DO UPDATE SET observable_generation = observable_generation + 1,
        observable_epoch = CASE WHEN observable_epoch = '' THEN excluded.observable_epoch ELSE observable_epoch END;`;
    db.exec(`DROP TRIGGER IF EXISTS ${name}; CREATE TRIGGER ${name} AFTER ${operation} ON ${table}
      ${operation === "UPDATE" ? `WHEN ${changed}` : ""} BEGIN ${writes} END;`);
  }
}
