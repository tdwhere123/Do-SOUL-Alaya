import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { AlayaError } from "@do-soul/alaya-protocol";
import {
  bindEmbeddingOverlay,
  detachEmbeddingOverlay,
  embeddingOverlayBindPath,
  hasEmbeddingOverlayBind,
  initDatabase,
  readSchemaMigrationLedger,
  writeEmbeddingOverlayBind,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { copyRegularFileNoFollow, hashRegularFileNoFollow } from "../../bound-file.js";
import {
  readEmbeddingCacheOverlay,
  type EmbeddingCacheOverlayBinding,
  type EmbeddingCacheOverlayExpectedSourceBinding
} from "./contract.js";
import { assertIsolatedOverlayFile } from "../workspace-slice/overlay-replicate.js";

const OVERLAY_ALIAS = "embedding_overlay";

export async function applyEmbeddingCacheOverlay(input: {
  readonly receiptPath: string;
  readonly restoredDbPath: string;
  readonly expected: EmbeddingCacheOverlayExpectedSourceBinding;
}): Promise<EmbeddingCacheOverlayBinding> {
  assertRestoredSchema(input.restoredDbPath, input.expected.source_schema_version);
  const loaded = readEmbeddingCacheOverlay({
    receiptPath: input.receiptPath,
    expected: input.expected
  });
  const boundPath = join(
    dirname(input.restoredDbPath),
    `.embedding-cache-overlay-${loaded.binding.overlay_sha256}.sqlite`
  );
  if (resolve(loaded.overlayPath) === resolve(boundPath)) {
    throw new Error("embedding cache overlay input must differ from its bound working copy");
  }
  if (reuseExistingOverlayBind(input.restoredDbPath, boundPath, loaded.binding.overlay_sha256)) {
    if (hashRegularFileNoFollow(loaded.overlayPath) !== loaded.binding.overlay_sha256) {
      throw new AlayaError("CONFLICT", "embedding cache overlay source digest mismatch");
    }
    // SQLite attach can change journal/header bytes; overlay rows remain immutable.
    assertIsolatedOverlayFile(loaded.overlayPath, boundPath);
    assertBoundOverlayContents(loaded.overlayPath, boundPath);
    return loaded.binding;
  }
  copyRegularFileNoFollow({
    sourcePath: loaded.overlayPath,
    targetPath: boundPath,
    expectedSha256: loaded.binding.overlay_sha256
  });
  assertIsolatedOverlayFile(loaded.overlayPath, boundPath);
  // Do not chmod the overlay 444: attaching a read-only file makes SQLite
  // reject writes on the live working copy (EventLog / WAL).
  try {
    bindCopiedOverlay(input.restoredDbPath, boundPath, loaded.binding);
    return loaded.binding;
  } catch (error) {
    rmSync(boundPath, { force: true });
    rmSync(embeddingOverlayBindPath(input.restoredDbPath), { force: true });
    throw error;
  }
}

function assertBoundOverlayContents(sourcePath: string, boundPath: string): void {
  const database = new BetterSqlite3(boundPath, { readonly: true, fileMustExist: true });
  try {
    database.prepare("ATTACH DATABASE ? AS source_overlay").run(sourcePath);
    for (const table of ["memory_embeddings", "evidence_recall_embeddings"]) {
      const changed = database.prepare(`
        SELECT (SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = '${table}')
            IS NOT (SELECT sql FROM source_overlay.sqlite_schema WHERE type = 'table' AND name = '${table}')
          OR (SELECT COUNT(*) FROM main.${table}) != (SELECT COUNT(*) FROM source_overlay.${table})
          OR EXISTS(SELECT * FROM main.${table} EXCEPT SELECT * FROM source_overlay.${table})
          OR EXISTS(SELECT * FROM source_overlay.${table} EXCEPT SELECT * FROM main.${table}) AS changed
      `).get() as { changed: number };
      if (changed.changed !== 0) {
        throw new AlayaError("CONFLICT", "embedding cache overlay bound working copy content mismatch");
      }
    }
  } finally {
    database.close();
  }
}

function reuseExistingOverlayBind(
  restoredDbPath: string,
  boundPath: string,
  overlaySha256: string
): boolean {
  if (!hasEmbeddingOverlayBind(restoredDbPath) || !existsSync(boundPath)) return false;
  const bindPath = embeddingOverlayBindPath(restoredDbPath);
  try {
    const document = JSON.parse(readFileSync(bindPath, "utf8")) as {
      readonly overlay_sha256?: unknown;
      readonly overlay_filename?: unknown;
    };
    return document.overlay_sha256 === overlaySha256 &&
      document.overlay_filename === basename(boundPath) &&
      existsSync(boundPath);
  } catch {
    return false;
  }
}

function assertRestoredSchema(restoredDbPath: string, expected: number): void {
  if (readSchemaMigrationLedger(restoredDbPath).at(-1) !== expected) {
    throw new Error("embedding cache overlay restored DB schema binding mismatch");
  }
}

function bindCopiedOverlay(
  restoredDbPath: string,
  overlayPath: string,
  binding: EmbeddingCacheOverlayBinding
): void {
  const database = initDatabase({ filename: restoredDbPath });
  try {
    bindEmbeddingOverlay(database.connection, overlayPath);
    assertOverlayRows(database, binding);
    assertNoConflicts(database);
    assertReadProjection(database, binding);
    writeEmbeddingOverlayBind({
      databaseFilename: restoredDbPath,
      overlayFilename: basename(overlayPath),
      overlaySha256: binding.overlay_sha256
    });
    detachEmbeddingOverlay(database.connection);
  } finally {
    database.close();
  }
}

function assertOverlayRows(
  database: StorageDatabase,
  binding: EmbeddingCacheOverlayBinding
): void {
  const vector = binding.vector_space;
  const memory = readCount(database, `
    SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.memory_embeddings
    WHERE provider_kind = ? AND model_id = ? AND schema_version = ?
      AND dimensions = ? AND vector_valid = 1
  `, vector);
  const evidence = readCount(database, `
    SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.evidence_recall_embeddings
    WHERE provider_kind = ? AND model_id = ? AND schema_version = ?
      AND dimensions = ? AND vector_valid = 1
  `, vector);
  const totalMemory = readScalar(database, `
    SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.memory_embeddings
  `);
  const totalEvidence = readScalar(database, `
    SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.evidence_recall_embeddings
  `);
  if (memory !== binding.memory_embedding_count || totalMemory !== memory ||
      evidence !== binding.evidence_embedding_count || totalEvidence !== evidence) {
    throw new Error("embedding cache overlay row identity/count binding mismatch");
  }
}

function assertNoConflicts(database: StorageDatabase): void {
  const conflicts = readScalar(database, MEMORY_CONFLICT_COUNT_SQL) +
    readScalar(database, EVIDENCE_CONFLICT_COUNT_SQL);
  if (conflicts > 0) {
    throw new Error("embedding cache overlay conflicts with restored embedding rows");
  }
}

function assertReadProjection(
  database: StorageDatabase,
  binding: EmbeddingCacheOverlayBinding
): void {
  const durableMemory = readScalar(database, `
    SELECT COUNT(*) FROM main.memory_embeddings
  `);
  const durableEvidence = readScalar(database, `
    SELECT COUNT(*) FROM main.evidence_recall_embeddings
  `);
  const projectedMemory = readScalar(database, `SELECT COUNT(*) FROM memory_embeddings`);
  const projectedEvidence = readScalar(database, `
    SELECT COUNT(*) FROM evidence_recall_embeddings
  `);
  if (durableMemory !== 0 || durableEvidence !== 0) {
    throw new Error("embedding cache overlay requires empty durable embedding tables");
  }
  if (projectedMemory !== binding.memory_embedding_count ||
      projectedEvidence !== binding.evidence_embedding_count) {
    throw new Error("embedding cache overlay read projection mismatch");
  }
}

function readCount(
  database: StorageDatabase,
  sql: string,
  vector: EmbeddingCacheOverlayBinding["vector_space"]
): number {
  return database.connection.prepare(sql).pluck().get(
    vector.provider_kind,
    vector.model_id,
    vector.schema_version,
    vector.dimensions
  ) as number;
}

function readScalar(database: StorageDatabase, sql: string): number {
  return database.connection.prepare(sql).pluck().get() as number;
}

const MEMORY_CONFLICT_COUNT_SQL = `
  SELECT COUNT(*)
  FROM ${OVERLAY_ALIAS}.memory_embeddings overlay
  INNER JOIN main.memory_embeddings restored USING (object_id)
  WHERE NOT (
    restored.workspace_id IS overlay.workspace_id AND
    restored.content_hash IS overlay.content_hash AND
    restored.provider_kind IS overlay.provider_kind AND
    restored.model_id IS overlay.model_id AND
    restored.schema_version IS overlay.schema_version AND
    restored.dimensions IS overlay.dimensions AND
    restored.embedding_blob IS overlay.embedding_blob AND
    restored.vector_valid IS overlay.vector_valid AND
    restored.created_at IS overlay.created_at AND
    restored.updated_at IS overlay.updated_at
  )
`;

const EVIDENCE_CONFLICT_COUNT_SQL = `
  SELECT COUNT(*)
  FROM ${OVERLAY_ALIAS}.evidence_recall_embeddings overlay
  INNER JOIN main.evidence_recall_embeddings restored
    USING (workspace_id, owner_object_id, document_identity, document_role)
  WHERE NOT (
    restored.content_hash IS overlay.content_hash AND
    restored.provider_kind IS overlay.provider_kind AND
    restored.model_id IS overlay.model_id AND
    restored.schema_version IS overlay.schema_version AND
    restored.dimensions IS overlay.dimensions AND
    restored.embedding_blob IS overlay.embedding_blob AND
    restored.vector_valid IS overlay.vector_valid AND
    restored.created_at IS overlay.created_at AND
    restored.updated_at IS overlay.updated_at
  )
`;
