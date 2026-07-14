import { createHash } from "node:crypto";
import { StorageError } from "../../shared/errors.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import type { MemoryEmbeddingMetadataRow, MemoryEmbeddingRow } from "../shared/sqlite-row-schemas.js";
import type { MemoryEmbeddingMetadata, MemoryEmbeddingRecord } from "./memory-embedding-repo.js";

export type { MemoryEmbeddingMetadataRow, MemoryEmbeddingRow } from "../shared/sqlite-row-schemas.js";

export const MEMORY_EMBEDDING_SELECT_COLUMNS = `
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
`;

export const MEMORY_EMBEDDING_SELECT_COLUMNS_QUALIFIED = `
      memory_embeddings.object_id AS object_id,
      memory_embeddings.workspace_id AS workspace_id,
      memory_embeddings.content_hash AS content_hash,
      memory_embeddings.provider_kind AS provider_kind,
      memory_embeddings.model_id AS model_id,
      memory_embeddings.schema_version AS schema_version,
      memory_embeddings.dimensions AS dimensions,
      memory_embeddings.embedding_blob AS embedding_blob,
      memory_embeddings.created_at AS created_at,
      memory_embeddings.updated_at AS updated_at
`;

export const MEMORY_EMBEDDING_METADATA_COLUMNS = `
      object_id,
      workspace_id,
      content_hash,
      provider_kind,
      model_id,
      schema_version,
      dimensions,
      created_at,
      updated_at
`;

const MEMORY_EMBEDDING_OBJECT_ID_CHUNK_SIZE = 900;

export function chunkObjectIds(objectIds: readonly string[]): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < objectIds.length; offset += MEMORY_EMBEDDING_OBJECT_ID_CHUNK_SIZE) {
    chunks.push(objectIds.slice(offset, offset + MEMORY_EMBEDDING_OBJECT_ID_CHUNK_SIZE));
  }
  return chunks;
}

export function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function runUpsertArgs(parsedRecord: Readonly<MemoryEmbeddingRecord>): [
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  Buffer,
  string,
  string
] {
  return [
    parsedRecord.object_id,
    parsedRecord.workspace_id,
    parsedRecord.content_hash,
    parsedRecord.provider_kind,
    parsedRecord.model_id,
    parsedRecord.schema_version,
    parsedRecord.dimensions,
    serializeEmbedding(parsedRecord.embedding),
    parsedRecord.created_at,
    parsedRecord.updated_at
  ];
}

export function parseMemoryEmbeddingRecord(
  value: MemoryEmbeddingRecord
): Readonly<MemoryEmbeddingRecord> {
  const embedding = parseEmbedding(value.embedding, "embedding");
  const dimensions = parseDimensions(value.dimensions);
  assertEmbeddingDimensions(embedding, dimensions);
  return buildMemoryEmbeddingRecord(value, dimensions, embedding);
}

export function parseMemoryEmbeddingRow(row: MemoryEmbeddingRow): Readonly<MemoryEmbeddingRecord> {
  const dimensions = parseDimensions(row.dimensions);
  const embedding = deserializeEmbedding(row.embedding_blob, dimensions);
  assertEmbeddingDimensions(embedding, dimensions);
  return buildMemoryEmbeddingRecord(row, dimensions, embedding);
}

function buildMemoryEmbeddingRecord(
  value: MemoryEmbeddingRecord | MemoryEmbeddingRow,
  dimensions: number,
  embedding: Float32Array
): Readonly<MemoryEmbeddingRecord> {
  return Object.freeze({
    object_id: parseObjectId(value.object_id),
    workspace_id: parseWorkspaceId(value.workspace_id),
    content_hash: parseContentHash(value.content_hash),
    provider_kind: parseProviderKind(value.provider_kind),
    model_id: parseModelId(value.model_id),
    schema_version: parseSchemaVersion(value.schema_version),
    dimensions,
    embedding,
    created_at: parseTimestamp(value.created_at),
    updated_at: parseTimestamp(value.updated_at)
  });
}

export function parseMemoryEmbeddingMetadataRow(
  row: MemoryEmbeddingMetadataRow
): Readonly<MemoryEmbeddingMetadata> {
  return Object.freeze({
    object_id: parseObjectId(row.object_id),
    workspace_id: parseWorkspaceId(row.workspace_id),
    content_hash: parseContentHash(row.content_hash),
    provider_kind: parseProviderKind(row.provider_kind),
    model_id: parseModelId(row.model_id),
    schema_version: parseSchemaVersion(row.schema_version),
    dimensions: parseDimensions(row.dimensions),
    created_at: parseTimestamp(row.created_at),
    updated_at: parseTimestamp(row.updated_at)
  });
}

function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(copyBytes(new Uint8Array(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength
  )));
}

function deserializeEmbedding(blob: Buffer, dimensions: number): Float32Array {
  const expectedByteLength = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (blob.byteLength !== expectedByteLength) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Embedding blob size ${blob.byteLength} did not match dimensions ${dimensions}.`
    );
  }

  const embedding = new Float32Array(copyBytes(blob));
  assertValidEmbedding(embedding, "embedding");
  return embedding;
}

function parseEmbedding(value: Float32Array, fieldName: string): Float32Array {
  assertValidEmbedding(value, fieldName);
  return new Float32Array(value);
}

function assertValidEmbedding(value: Float32Array, fieldName: string): void {
  if (!(value instanceof Float32Array)) {
    throw new StorageError("VALIDATION_FAILED", `${fieldName} must be a Float32Array.`);
  }

  if (value.length === 0) {
    throw new StorageError("VALIDATION_FAILED", `${fieldName} must not be empty.`);
  }

  for (const element of value) {
    if (!Number.isFinite(element)) {
      throw new StorageError("VALIDATION_FAILED", `${fieldName} must contain only finite numbers.`);
    }
  }
}

function assertEmbeddingDimensions(embedding: Float32Array, dimensions: number): void {
  if (embedding.length !== dimensions) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Embedding length ${embedding.length} did not match declared dimensions ${dimensions}.`
    );
  }
}

// invariant: mapper outputs never retain caller- or SQLite-owned mutable bytes.
function copyBytes(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function parseDimensions(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", "dimensions must be a positive integer.");
  }

  return value;
}

function parseSchemaVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", "schema_version must be a positive integer.");
  }

  return value;
}

export const parseObjectId = (value: string): string => parseNonEmptyString(value, "object_id");
export const parseWorkspaceId = (value: string): string => parseNonEmptyString(value, "workspace_id");
const parseContentHash = (value: string): string => parseNonEmptyString(value, "content_hash");
export const parseProviderKind = (value: string): string => parseNonEmptyString(value, "provider_kind");
export const parseModelId = (value: string): string => parseNonEmptyString(value, "model_id");
