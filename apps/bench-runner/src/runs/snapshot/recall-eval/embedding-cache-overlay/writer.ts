import { rmSync } from "node:fs";
import { basename } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  readSchemaMigrationLedger
} from "@do-soul/alaya-storage";
import { publishExclusiveOutput } from
  "../../../../cli/output/exclusive-output.js";
import { sha256File } from "../../integrity.js";
import {
  buildEmbeddingCacheOverlayReceipt,
  readEmbeddingCacheOverlay,
  type EmbeddingCacheOverlayBinding,
  type EmbeddingCacheOverlaySourceBinding
} from "./contract.js";
import {
  createOverlaySchema,
  publishOverlayDatabase,
  reserveStagingFile,
  resolveOverlayOutputPaths
} from "./overlay-schema.js";

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export async function writeEmbeddingCacheOverlay(input: {
  readonly warmedDbPath: string;
  readonly receiptPath: string;
  readonly source: EmbeddingCacheOverlaySourceBinding;
}): Promise<EmbeddingCacheOverlayBinding> {
  assertSourceSchema(input);
  const paths = resolveOverlayOutputPaths(input.receiptPath);
  reserveStagingFile(paths.stagingPath);
  try {
    const counts = buildOverlayDatabase(input.warmedDbPath, paths.stagingPath, input.source);
    return await sealEmbeddingCacheOverlay({
      stagingPath: paths.stagingPath,
      receiptPath: paths.receiptPath,
      overlayPath: paths.overlayPath,
      source: input.source,
      memoryEmbeddingCount: counts.memory,
      evidenceEmbeddingCount: counts.evidence
    });
  } catch (error) {
    rmSync(paths.stagingPath, { force: true });
    rmSync(`${paths.stagingPath}-wal`, { force: true });
    rmSync(`${paths.stagingPath}-shm`, { force: true });
    throw error;
  }
}

export async function sealEmbeddingCacheOverlay(input: {
  readonly stagingPath: string;
  readonly receiptPath: string;
  readonly overlayPath: string;
  readonly source: EmbeddingCacheOverlaySourceBinding;
  readonly memoryEmbeddingCount: number;
  readonly evidenceEmbeddingCount: number;
}): Promise<EmbeddingCacheOverlayBinding> {
  let overlayPublished = false;
  let receiptPublished = false;
  try {
    const overlaySha256 = await sha256File(input.stagingPath);
    publishOverlayDatabase(input.stagingPath, input.overlayPath);
    overlayPublished = true;
    const receipt = buildEmbeddingCacheOverlayReceipt({
      source: input.source,
      relativeOverlayPath: basename(input.overlayPath),
      overlaySha256,
      memoryEmbeddingCount: input.memoryEmbeddingCount,
      evidenceEmbeddingCount: input.evidenceEmbeddingCount
    });
    await publishExclusiveOutput(
      input.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    receiptPublished = true;
    return readEmbeddingCacheOverlay({
      receiptPath: input.receiptPath,
      expected: input.source
    }).binding;
  } catch (error) {
    if (overlayPublished) rmSync(input.overlayPath, { force: true });
    if (receiptPublished) rmSync(input.receiptPath, { force: true });
    throw error;
  }
}

function assertSourceSchema(input: {
  readonly warmedDbPath: string;
  readonly source: EmbeddingCacheOverlaySourceBinding;
}): void {
  const actual = readSchemaMigrationLedger(input.warmedDbPath).at(-1);
  if (actual !== input.source.source_schema_version) {
    throw new Error("embedding cache overlay warmed DB schema binding mismatch");
  }
}

function buildOverlayDatabase(
  warmedDbPath: string,
  overlayPath: string,
  source: EmbeddingCacheOverlaySourceBinding
): { readonly memory: number; readonly evidence: number } {
  const database = new BetterSqlite3(overlayPath);
  const warmed = new BetterSqlite3(warmedDbPath, {
    readonly: true,
    fileMustExist: true
  });
  try {
    createOverlaySchema(database);
    const counts = copyMatchingRows(warmed, database, source);
    database.exec("VACUUM");
    return counts;
  } finally {
    warmed.close();
    database.close();
  }
}

function copyMatchingRows(
  warmed: SqliteDatabase,
  overlay: SqliteDatabase,
  source: EmbeddingCacheOverlaySourceBinding
): { readonly memory: number; readonly evidence: number } {
  const vector = source.vector_space;
  const transaction = overlay.transaction(() => {
    const args = [
      vector.provider_kind,
      vector.model_id,
      vector.schema_version,
      vector.dimensions
    ] as const;
    const memory = copyRows({
      source: warmed,
      target: overlay,
      selectSql: MEMORY_SELECT_SQL,
      insertSql: MEMORY_INSERT_SQL,
      args
    });
    const evidence = copyRows({
      source: warmed,
      target: overlay,
      selectSql: EVIDENCE_SELECT_SQL,
      insertSql: EVIDENCE_INSERT_SQL,
      args
    });
    if (memory + evidence === 0) {
      throw new Error("embedding cache overlay source contains no matching vectors");
    }
    return Object.freeze({ memory, evidence });
  });
  return transaction.immediate();
}

function copyRows(input: {
  readonly source: SqliteDatabase;
  readonly target: SqliteDatabase;
  readonly selectSql: string;
  readonly insertSql: string;
  readonly args: readonly [string, string, number, number];
}): number {
  const insert = input.target.prepare(input.insertSql);
  let count = 0;
  for (const row of input.source.prepare(input.selectSql).iterate(...input.args)) {
    insert.run(row as Record<string, unknown>);
    count += 1;
  }
  return count;
}

const MEMORY_COLUMNS = `
  object_id, workspace_id, content_hash, provider_kind, model_id,
  schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
`;

const MEMORY_SELECT_SQL = `
  SELECT ${MEMORY_COLUMNS} FROM memory_embeddings
  WHERE provider_kind = ? AND model_id = ? AND schema_version = ?
    AND dimensions = ? AND vector_valid = 1
  ORDER BY object_id
`;

const MEMORY_INSERT_SQL = `
  INSERT INTO memory_embeddings (${MEMORY_COLUMNS}) VALUES (
    @object_id, @workspace_id, @content_hash, @provider_kind, @model_id,
    @schema_version, @dimensions, @embedding_blob, @vector_valid, @created_at, @updated_at
  )
`;

const EVIDENCE_COLUMNS = `
  workspace_id, owner_object_id, document_identity, content_hash, document_role,
  provider_kind, model_id, schema_version, dimensions, embedding_blob,
  vector_valid, created_at, updated_at
`;

const EVIDENCE_SELECT_SQL = `
  SELECT ${EVIDENCE_COLUMNS} FROM evidence_recall_embeddings
  WHERE provider_kind = ? AND model_id = ? AND schema_version = ?
    AND dimensions = ? AND vector_valid = 1
  ORDER BY workspace_id, owner_object_id, document_identity, document_role
`;

const EVIDENCE_INSERT_SQL = `
  INSERT INTO evidence_recall_embeddings (${EVIDENCE_COLUMNS}) VALUES (
    @workspace_id, @owner_object_id, @document_identity, @content_hash, @document_role,
    @provider_kind, @model_id, @schema_version, @dimensions, @embedding_blob,
    @vector_valid, @created_at, @updated_at
  )
`;
