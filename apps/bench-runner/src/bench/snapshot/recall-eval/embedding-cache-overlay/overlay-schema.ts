import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  openSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export function createOverlaySchema(database: SqliteDatabase): void {
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

export function resolveOverlayOutputPaths(receiptPath: string): {
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

export function reserveStagingFile(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  closeSync(descriptor);
}

export function publishOverlayDatabase(stagingPath: string, overlayPath: string): void {
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
