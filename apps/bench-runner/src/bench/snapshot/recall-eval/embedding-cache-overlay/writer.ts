import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  openSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
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

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export async function writeEmbeddingCacheOverlay(input: {
  readonly warmedDbPath: string;
  readonly receiptPath: string;
  readonly source: EmbeddingCacheOverlaySourceBinding;
}): Promise<EmbeddingCacheOverlayBinding> {
  assertSourceSchema(input);
  const paths = resolveOutputPaths(input.receiptPath);
  reserveStagingFile(paths.stagingPath);
  let overlayPublished = false;
  let receiptPublished = false;
  try {
    const counts = buildOverlayDatabase(input.warmedDbPath, paths.stagingPath, input.source);
    const overlaySha256 = await sha256File(paths.stagingPath);
    publishOverlayDatabase(paths.stagingPath, paths.overlayPath);
    overlayPublished = true;
    const receipt = buildEmbeddingCacheOverlayReceipt({
      source: input.source,
      relativeOverlayPath: basename(paths.overlayPath),
      overlaySha256,
      memoryEmbeddingCount: counts.memory,
      evidenceEmbeddingCount: counts.evidence
    });
    await publishExclusiveOutput(
      paths.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    receiptPublished = true;
    return readEmbeddingCacheOverlay({
      receiptPath: paths.receiptPath,
      expected: input.source
    }).binding;
  } catch (error) {
    rmSync(paths.stagingPath, { force: true });
    if (receiptPublished) rmSync(paths.receiptPath, { force: true });
    if (overlayPublished) rmSync(paths.overlayPath, { force: true });
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

function resolveOutputPaths(receiptPath: string): {
  readonly receiptPath: string;
  readonly overlayPath: string;
  readonly stagingPath: string;
} {
  const resolvedReceipt = resolve(receiptPath);
  const root = dirname(resolvedReceipt);
  const extension = extname(resolvedReceipt);
  const stem = basename(resolvedReceipt, extension);
  const overlayPath = join(root, `${stem}.sqlite`);
  return {
    receiptPath: resolvedReceipt,
    overlayPath,
    stagingPath: join(root, `.${stem}.overlay-${process.pid}-${randomUUID()}.tmp`)
  };
}

function reserveStagingFile(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  closeSync(descriptor);
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

function createOverlaySchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE memory_embeddings (
      object_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, provider_kind TEXT NOT NULL,
      model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
      vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE evidence_recall_embeddings (
      workspace_id TEXT NOT NULL, owner_object_id TEXT NOT NULL,
      document_identity TEXT NOT NULL, content_hash TEXT NOT NULL,
      document_role TEXT NOT NULL, provider_kind TEXT NOT NULL,
      model_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
      dimensions INTEGER NOT NULL, embedding_blob BLOB NOT NULL,
      vector_valid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, owner_object_id, document_identity, document_role)
    );
  `);
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

function publishOverlayDatabase(stagingPath: string, overlayPath: string): void {
  try {
    linkSync(stagingPath, overlayPath);
    unlinkSync(stagingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`output already exists: ${overlayPath}`);
    }
    throw error;
  }
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
