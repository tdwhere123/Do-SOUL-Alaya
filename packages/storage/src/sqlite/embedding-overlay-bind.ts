import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { StorageError } from "../shared/errors.js";
import type { SqliteConnection } from "./db.js";

export const EMBEDDING_OVERLAY_BIND_FILENAME = ".alaya-embedding-overlay.json";
export const EMBEDDING_OVERLAY_ALIAS = "embedding_overlay";

const BIND_KIND = "alaya_sqlite_embedding_overlay";
const BIND_SCHEMA_VERSION = 1 as const;
const SHA256_CHUNK_BYTES = 1024 * 1024;

export interface EmbeddingOverlayBindDocument {
  readonly schema_version: typeof BIND_SCHEMA_VERSION;
  readonly kind: typeof BIND_KIND;
  readonly overlay_filename: string;
  readonly overlay_sha256: string;
}

export function embeddingOverlayBindPath(databaseFilename: string): string {
  return path.join(path.dirname(databaseFilename), EMBEDDING_OVERLAY_BIND_FILENAME);
}

export function hasEmbeddingOverlayBind(databaseFilename: string): boolean {
  if (databaseFilename === ":memory:") return false;
  try {
    readFileSync(embeddingOverlayBindPath(databaseFilename));
    return true;
  } catch {
    return false;
  }
}

export function writeEmbeddingOverlayBind(input: {
  readonly databaseFilename: string;
  readonly overlayFilename: string;
  readonly overlaySha256: string;
}): void {
  if (input.databaseFilename === ":memory:") {
    throw new StorageError(
      "VALIDATION_FAILED",
      "embedding overlay cannot bind to an in-memory database"
    );
  }
  if (path.basename(input.overlayFilename) !== input.overlayFilename) {
    throw new StorageError("VALIDATION_FAILED", "embedding overlay filename must be a basename");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.overlaySha256)) {
    throw new StorageError("VALIDATION_FAILED", "embedding overlay SHA-256 is invalid");
  }
  const document: EmbeddingOverlayBindDocument = {
    schema_version: BIND_SCHEMA_VERSION,
    kind: BIND_KIND,
    overlay_filename: input.overlayFilename,
    overlay_sha256: input.overlaySha256
  };
  writeFileSync(
    embeddingOverlayBindPath(input.databaseFilename),
    `${JSON.stringify(document)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export function bindEmbeddingOverlay(
  connection: SqliteConnection,
  overlayPath: string
): void {
  if (!isOverlayAttached(connection)) {
    connection.prepare(`ATTACH DATABASE ? AS ${EMBEDDING_OVERLAY_ALIAS}`).run(overlayPath);
  }
  ensureOverlayViews(connection);
}

export function detachEmbeddingOverlay(connection: SqliteConnection): void {
  if (!isOverlayAttached(connection)) return;
  connection.exec(`
    DROP VIEW IF EXISTS memory_embeddings;
    DROP VIEW IF EXISTS evidence_recall_embeddings;
  `);
  try {
    connection.exec(`DETACH DATABASE ${EMBEDDING_OVERLAY_ALIAS}`);
  } catch {
    // Preserve the caller failure; detach is best-effort on the way out.
  }
}

export function bindEmbeddingOverlayIfPresent(
  connection: SqliteConnection,
  databaseFilename: string
): void {
  if (databaseFilename === ":memory:") return;
  if (isOverlayAttached(connection)) {
    ensureOverlayViews(connection);
    return;
  }
  const bind = readBindDocument(databaseFilename);
  if (bind === null) return;
  const overlayPath = path.join(path.dirname(databaseFilename), bind.overlay_filename);
  if (sha256FileSync(overlayPath) !== bind.overlay_sha256) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "embedding overlay file SHA-256 binding mismatch"
    );
  }
  bindEmbeddingOverlay(connection, overlayPath);
}

function isOverlayAttached(connection: SqliteConnection): boolean {
  const rows = connection.pragma("database_list") as ReadonlyArray<Readonly<{ name: string }>>;
  return rows.some((row) => row.name === EMBEDDING_OVERLAY_ALIAS);
}

function ensureOverlayViews(connection: SqliteConnection): void {
  connection.exec(`
    CREATE TEMP VIEW IF NOT EXISTS memory_embeddings AS
    SELECT
      object_id, workspace_id, content_hash, provider_kind, model_id,
      schema_version, dimensions, embedding_blob, created_at, updated_at, vector_valid
    FROM main.memory_embeddings
    UNION ALL
    SELECT
      object_id, workspace_id, content_hash, provider_kind, model_id,
      schema_version, dimensions, embedding_blob, created_at, updated_at, vector_valid
    FROM ${EMBEDDING_OVERLAY_ALIAS}.memory_embeddings AS overlay
    WHERE NOT EXISTS (
      SELECT 1 FROM main.memory_embeddings AS durable
      WHERE durable.object_id = overlay.object_id
    );
    CREATE TEMP VIEW IF NOT EXISTS evidence_recall_embeddings AS
    SELECT
      workspace_id, owner_object_id, document_identity, content_hash, document_role,
      provider_kind, model_id, schema_version, dimensions, embedding_blob,
      vector_valid, created_at, updated_at
    FROM main.evidence_recall_embeddings
    UNION ALL
    SELECT
      workspace_id, owner_object_id, document_identity, content_hash, document_role,
      provider_kind, model_id, schema_version, dimensions, embedding_blob,
      vector_valid, created_at, updated_at
    FROM ${EMBEDDING_OVERLAY_ALIAS}.evidence_recall_embeddings AS overlay
    WHERE NOT EXISTS (
      SELECT 1 FROM main.evidence_recall_embeddings AS durable
      WHERE durable.workspace_id = overlay.workspace_id
        AND durable.owner_object_id = overlay.owner_object_id
        AND durable.document_identity = overlay.document_identity
        AND durable.document_role = overlay.document_role
    );
  `);
}

function readBindDocument(databaseFilename: string): EmbeddingOverlayBindDocument | null {
  let raw: string;
  try {
    raw = readFileSync(embeddingOverlayBindPath(databaseFilename), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new StorageError("VALIDATION_FAILED", "embedding overlay bind document must be JSON");
  }
  if (!isBindDocument(value)) {
    throw new StorageError("VALIDATION_FAILED", "embedding overlay bind document is invalid");
  }
  return value;
}

function isBindDocument(value: unknown): value is EmbeddingOverlayBindDocument {
  if (typeof value !== "object" || value === null) return false;
  const document = value as Record<string, unknown>;
  return document.schema_version === BIND_SCHEMA_VERSION &&
    document.kind === BIND_KIND &&
    typeof document.overlay_filename === "string" &&
    path.basename(document.overlay_filename) === document.overlay_filename &&
    typeof document.overlay_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(document.overlay_sha256);
}

function sha256FileSync(filePath: string): string {
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(SHA256_CHUNK_BYTES);
    let bytes = 0;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
