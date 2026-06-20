import type { StorageDatabase } from "../../sqlite/db.js";
import {
  MEMORY_EMBEDDING_SELECT_COLUMNS,
  MEMORY_EMBEDDING_SELECT_COLUMNS_QUALIFIED
} from "./memory-embedding-mappers.js";

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { readonly changes: number };
}

export interface MemoryEmbeddingStatements {
  readonly upsertStatement: SqliteStatement;
  readonly findByObjectIdStatement: SqliteStatement;
  readonly listByWorkspaceStatement: SqliteStatement;
  readonly findCurrentMemoryContentStatement: SqliteStatement;
  readonly clearObjectIdFilterStatement: SqliteStatement;
  readonly insertObjectIdFilterStatement: SqliteStatement;
  readonly listByObjectIdFilterStatement: SqliteStatement;
}

export function prepareMemoryEmbeddingStatements(db: StorageDatabase): MemoryEmbeddingStatements {
  ensureObjectIdFilterTable(db);
  return {
    upsertStatement: db.connection.prepare(UPSERT_MEMORY_EMBEDDING_SQL),
    findByObjectIdStatement: db.connection.prepare(`
      SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS}
      FROM memory_embeddings
      WHERE object_id = ?
      LIMIT 1
    `),
    listByWorkspaceStatement: db.connection.prepare(`
      SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS}
      FROM memory_embeddings
      WHERE workspace_id = ?
      ORDER BY object_id ASC
    `),
    findCurrentMemoryContentStatement: db.connection.prepare(`
      SELECT content
      FROM memory_entries
      WHERE object_id = ?
        AND workspace_id = ?
      LIMIT 1
    `),
    clearObjectIdFilterStatement: db.connection.prepare(`
      DELETE FROM temp.memory_embedding_object_id_filter
    `),
    insertObjectIdFilterStatement: db.connection.prepare(`
      INSERT OR IGNORE INTO temp.memory_embedding_object_id_filter (object_id)
      VALUES (?)
    `),
    listByObjectIdFilterStatement: db.connection.prepare(`
      SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS_QUALIFIED}
      FROM memory_embeddings
      INNER JOIN temp.memory_embedding_object_id_filter filter_ids
        ON filter_ids.object_id = memory_embeddings.object_id
      WHERE workspace_id = ?
      ORDER BY memory_embeddings.object_id ASC
    `)
  };
}

function ensureObjectIdFilterTable(db: StorageDatabase): void {
  db.connection.exec(`
    CREATE TEMP TABLE IF NOT EXISTS memory_embedding_object_id_filter (
      object_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
}

const UPSERT_MEMORY_EMBEDDING_SQL = `
      INSERT INTO memory_embeddings (
        object_id,
        workspace_id,
        content_hash,
        provider_kind,
        model_id,
        schema_version,
        dimensions,
        embedding_blob,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        content_hash = excluded.content_hash,
        provider_kind = excluded.provider_kind,
        model_id = excluded.model_id,
        schema_version = excluded.schema_version,
        dimensions = excluded.dimensions,
        embedding_blob = excluded.embedding_blob,
        updated_at = excluded.updated_at
`;
