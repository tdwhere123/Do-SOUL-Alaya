import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StorageError } from "../shared/errors.js";

export const EMBEDDING_OVERLAY_BIND_FILENAME = ".alaya-embedding-overlay.json";
export const EMBEDDING_OVERLAY_ALIAS = "embedding_overlay";

/** Duck-typed because overlay TEMP views are per-connection, not engine-specific. */
export interface EmbeddingOverlayBindConnection {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

const BIND_KIND = "alaya_sqlite_embedding_overlay";
const BIND_SCHEMA_VERSION = 1 as const;

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
  connection: EmbeddingOverlayBindConnection,
  overlayPath: string
): void {
  const attachedPath = attachedOverlayPath(connection);
  if (attachedPath === null) {
    connection.prepare(`ATTACH DATABASE ? AS ${EMBEDDING_OVERLAY_ALIAS}`).run(overlayPath);
  } else if (canonicalPath(attachedPath) !== canonicalPath(overlayPath)) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "embedding overlay binding does not match the attached sidecar"
    );
  }
  ensureOverlayViews(connection);
}

export function detachEmbeddingOverlay(connection: EmbeddingOverlayBindConnection): void {
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
  connection: EmbeddingOverlayBindConnection,
  databaseFilename: string
): void {
  if (databaseFilename === ":memory:") return;
  const bind = readBindDocument(databaseFilename);
  const attachedPath = attachedOverlayPath(connection);
  if (bind === null) {
    if (attachedPath !== null) detachEmbeddingOverlay(connection);
    return;
  }
  const overlayPath = path.join(path.dirname(databaseFilename), bind.overlay_filename);
  if (!existsSync(overlayPath)) {
    throw new StorageError("VALIDATION_FAILED", "embedding overlay file is missing");
  }
  if (attachedPath !== null) {
    if (canonicalPath(attachedPath) !== canonicalPath(overlayPath)) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "embedding overlay binding does not match the attached sidecar"
      );
    }
    ensureOverlayViews(connection);
    return;
  }
  // The sealed digest is checked when the sidecar is copied. Later ATTACH can
  // create WAL next to that file, so re-hashing here is not a stable identity.
  bindEmbeddingOverlay(connection, overlayPath);
}

function isOverlayAttached(connection: EmbeddingOverlayBindConnection): boolean {
  return attachedOverlayPath(connection) !== null;
}

function attachedOverlayPath(connection: EmbeddingOverlayBindConnection): string | null {
  const rows = connection.prepare("SELECT name, file FROM pragma_database_list").all() as
    ReadonlyArray<Readonly<{ name: string; file?: string }>>;
  return rows.find((row) => row.name === EMBEDDING_OVERLAY_ALIAS)?.file ?? null;
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function ensureOverlayViews(connection: EmbeddingOverlayBindConnection): void {
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
