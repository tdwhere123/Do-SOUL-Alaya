import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  initDatabase,
  readSchemaMigrationLedger,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { copyRegularFileNoFollow } from "../../bound-file.js";
import {
  readEmbeddingCacheOverlay,
  type EmbeddingCacheOverlayBinding,
  type EmbeddingCacheOverlayExpectedSourceBinding
} from "./contract.js";

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
  copyRegularFileNoFollow({
    sourcePath: loaded.overlayPath,
    targetPath: boundPath,
    expectedSha256: loaded.binding.overlay_sha256
  });
  try {
    importBoundOverlay(input.restoredDbPath, boundPath, loaded.binding);
    return loaded.binding;
  } finally {
    rmSync(boundPath, { force: true });
  }
}

function assertRestoredSchema(restoredDbPath: string, expected: number): void {
  if (readSchemaMigrationLedger(restoredDbPath).at(-1) !== expected) {
    throw new Error("embedding cache overlay restored DB schema binding mismatch");
  }
}

function importBoundOverlay(
  restoredDbPath: string,
  overlayPath: string,
  binding: EmbeddingCacheOverlayBinding
): void {
  const database = initDatabase({ filename: restoredDbPath });
  let attached = false;
  try {
    database.connection.prepare(`ATTACH DATABASE ? AS ${OVERLAY_ALIAS}`).run(overlayPath);
    attached = true;
    assertOverlayRows(database, binding);
    applyRowsAtomically(database, binding);
    database.connection.exec(`DETACH DATABASE ${OVERLAY_ALIAS}`);
    attached = false;
  } finally {
    if (attached) detachBestEffort(database);
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

function applyRowsAtomically(
  database: StorageDatabase,
  binding: EmbeddingCacheOverlayBinding
): void {
  database.connection.transaction(() => {
    const conflicts = readScalar(database, MEMORY_CONFLICT_COUNT_SQL) +
      readScalar(database, EVIDENCE_CONFLICT_COUNT_SQL);
    if (conflicts > 0) {
      throw new Error("embedding cache overlay conflicts with restored embedding rows");
    }
    database.connection.exec(MEMORY_IMPORT_SQL);
    database.connection.exec(EVIDENCE_IMPORT_SQL);
    const memoryMatches = readScalar(database, MEMORY_MATCH_COUNT_SQL);
    const evidenceMatches = readScalar(database, EVIDENCE_MATCH_COUNT_SQL);
    if (memoryMatches !== binding.memory_embedding_count ||
        evidenceMatches !== binding.evidence_embedding_count) {
      throw new Error("embedding cache overlay import closure mismatch");
    }
  }).immediate();
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

function detachBestEffort(database: StorageDatabase): void {
  try {
    database.connection.exec(`DETACH DATABASE ${OVERLAY_ALIAS}`);
  } catch {
    // Preserve the validation/import failure that caused cleanup.
  }
}

const MEMORY_COLUMNS = `
  object_id, workspace_id, content_hash, provider_kind, model_id,
  schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
`;

const MEMORY_IMPORT_SQL = `
  INSERT OR IGNORE INTO main.memory_embeddings (${MEMORY_COLUMNS})
  SELECT ${MEMORY_COLUMNS} FROM ${OVERLAY_ALIAS}.memory_embeddings
  ORDER BY object_id
`;

const EVIDENCE_COLUMNS = `
  workspace_id, owner_object_id, document_identity, content_hash, document_role,
  provider_kind, model_id, schema_version, dimensions, embedding_blob,
  vector_valid, created_at, updated_at
`;

const EVIDENCE_IMPORT_SQL = `
  INSERT OR IGNORE INTO main.evidence_recall_embeddings (${EVIDENCE_COLUMNS})
  SELECT ${EVIDENCE_COLUMNS} FROM ${OVERLAY_ALIAS}.evidence_recall_embeddings
  ORDER BY workspace_id, owner_object_id, document_identity, document_role
`;

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

const MEMORY_MATCH_COUNT_SQL = `
  SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.memory_embeddings overlay
  INNER JOIN main.memory_embeddings restored
    ON restored.object_id = overlay.object_id
   AND restored.embedding_blob IS overlay.embedding_blob
   AND restored.content_hash = overlay.content_hash
   AND restored.provider_kind = overlay.provider_kind
   AND restored.model_id = overlay.model_id
   AND restored.schema_version = overlay.schema_version
   AND restored.dimensions = overlay.dimensions
   AND restored.vector_valid = overlay.vector_valid
`;

const EVIDENCE_MATCH_COUNT_SQL = `
  SELECT COUNT(*) FROM ${OVERLAY_ALIAS}.evidence_recall_embeddings overlay
  INNER JOIN main.evidence_recall_embeddings restored
    ON restored.workspace_id = overlay.workspace_id
   AND restored.owner_object_id = overlay.owner_object_id
   AND restored.document_identity = overlay.document_identity
   AND restored.document_role = overlay.document_role
   AND restored.embedding_blob IS overlay.embedding_blob
   AND restored.content_hash = overlay.content_hash
   AND restored.provider_kind = overlay.provider_kind
   AND restored.model_id = overlay.model_id
   AND restored.schema_version = overlay.schema_version
   AND restored.dimensions = overlay.dimensions
   AND restored.vector_valid = overlay.vector_valid
`;
