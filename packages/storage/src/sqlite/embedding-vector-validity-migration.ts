import type { SqliteConnection } from "./db.js";
import { isValidEmbeddingBlob } from "../repos/memory/embedding-vector-validity.js";

interface StoredEmbeddingProbe {
  readonly object_id: string;
  readonly dimensions: number;
  readonly embedding_blob: Buffer;
}

export function migrateEmbeddingVectorValidity(database: SqliteConnection): void {
  // Keyset pages keep peak BLOB retention bounded; the one-time scan is linear
  // in stored vector components rather than a permanent backfill hydration cost.
  const readPage = database.prepare(`
    SELECT object_id, dimensions, embedding_blob
    FROM memory_embeddings
    WHERE object_id > ?
    ORDER BY object_id
    LIMIT 500
  `);
  const markValid = database.prepare(`
    UPDATE memory_embeddings SET vector_valid = 1 WHERE object_id = ?
  `);
  database.prepare("UPDATE memory_embeddings SET vector_valid = 0").run();
  let cursor = "";
  while (true) {
    const rows = readPage.all(cursor) as StoredEmbeddingProbe[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (isValidEmbeddingBlob(row.embedding_blob, row.dimensions)) {
        markValid.run(row.object_id);
      }
    }
    cursor = rows.at(-1)!.object_id;
  }
  database.prepare(`
    UPDATE memory_embeddings
       SET vector_valid = 0
     WHERE vector_valid = 1
       AND (provider_kind, model_id, schema_version) IN (
         SELECT provider_kind, model_id, schema_version
           FROM memory_embeddings
          WHERE vector_valid = 1
          GROUP BY provider_kind, model_id, schema_version
         HAVING COUNT(DISTINCT dimensions) > 1
       )
  `).run();
}
