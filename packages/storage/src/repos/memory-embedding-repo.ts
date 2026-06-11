import { createHash } from "node:crypto";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface MemoryEmbeddingRecord {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding: Float32Array;
  readonly created_at: string;
  readonly updated_at: string;
}

// Metadata-only projection of a memory_embeddings row: every column EXCEPT the
// embedding blob. The backfill cache-hit/stale decision needs only these fields
// (content_hash + provider/model/schema match, created_at preservation on
// upsert), so reading metadata avoids both per-row blob hydration and the
// finite-check scan over the full vector.
// see also: packages/core/src/embedding-backfill-handler.ts EmbeddingBackfillRepoPort
export interface MemoryEmbeddingMetadata {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemoryEmbeddingListByWorkspaceOptions {
  // Optional storage-tier whitelist. Applied at the SQL JOIN to drop WARM /
  // COLD memories before they enter the embedding candidate pool (see also
  // EmbeddingRecallRepoPort).
  readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
  // Hard cap on the rows returned. Applied after tier filtering.
  readonly limit?: number;
  // invariant: cosine space is valid only within one (provider_kind, model_id).
  // SQL-level filter so the workspace scan cap admits only vectors that can
  // compete; cross-provider rows are dropped before the cap, not after.
  // see also: packages/core/src/embedding-recall/constants.ts:EMBEDDING_WORKSPACE_SCAN_CAP
  readonly providerKind?: string;
  readonly modelId?: string;
}

export interface MemoryEmbeddingRepo {
  upsert(record: MemoryEmbeddingRecord): Promise<Readonly<MemoryEmbeddingRecord>>;
  upsertIfContentHashMatchesCurrentMemory(
    record: MemoryEmbeddingRecord
  ): Promise<Readonly<MemoryEmbeddingRecord> | null>;
  findByObjectId(objectId: string): Promise<Readonly<MemoryEmbeddingRecord> | null>;
  // Batch metadata-only lookup (no embedding blob). Implementations may chunk
  // large id sets to stay below storage bind limits; the backfill handler uses
  // this for its cache-hit/stale decision so it pays neither n per-id round-trips
  // nor full-vector hydration. Returns the row for every matched object_id
  // regardless of provider/model/schema — the
  // provider/model/schema equality check and created_at preservation belong in
  // the handler.
  findMetadataByObjectIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEmbeddingMetadata>[]>;
  listByWorkspace(
    workspaceId: string,
    options?: MemoryEmbeddingListByWorkspaceOptions
  ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
  listByObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
}

interface MemoryEmbeddingRow {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly embedding_blob: Buffer;
  readonly created_at: string;
  readonly updated_at: string;
}

type MemoryEmbeddingMetadataRow = Omit<MemoryEmbeddingRow, "embedding_blob">;

const MEMORY_EMBEDDING_SELECT_COLUMNS = `
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

// Metadata column list: every column EXCEPT embedding_blob, so a metadata read
// never touches the vector payload.
const MEMORY_EMBEDDING_METADATA_COLUMNS = `
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

export class SqliteMemoryEmbeddingRepo implements MemoryEmbeddingRepo {
  private readonly upsertStatement;
  private readonly findByObjectIdStatement;
  private readonly listByWorkspaceStatement;
  private readonly findCurrentMemoryContentStatement;
  private readonly guardedUpsertTransaction;

  public constructor(private readonly db: StorageDatabase) {
    this.upsertStatement = db.connection.prepare(`
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
    `);
    this.findByObjectIdStatement = db.connection.prepare(`
      SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS}
      FROM memory_embeddings
      WHERE object_id = ?
      LIMIT 1
    `);
    this.listByWorkspaceStatement = db.connection.prepare(`
      SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS}
      FROM memory_embeddings
      WHERE workspace_id = ?
      ORDER BY object_id ASC
    `);
    this.findCurrentMemoryContentStatement = db.connection.prepare(`
      SELECT content
      FROM memory_entries
      WHERE object_id = ?
        AND workspace_id = ?
      LIMIT 1
    `);
    this.guardedUpsertTransaction = db.connection.transaction(
      (
        parsedRecord: Readonly<MemoryEmbeddingRecord>
      ): Readonly<MemoryEmbeddingRecord> | null => {
        const currentMemory = this.findCurrentMemoryContentStatement.get(
          parsedRecord.object_id,
          parsedRecord.workspace_id
        ) as { readonly content: string } | undefined;

        if (
          currentMemory === undefined ||
          hashMemoryContent(currentMemory.content) !== parsedRecord.content_hash
        ) {
          return null;
        }

        this.runUpsert(parsedRecord);

        const persisted = this.findByObjectIdStatement.get(
          parsedRecord.object_id
        ) as MemoryEmbeddingRow | undefined;
        if (persisted === undefined) {
          throw new StorageError(
            "QUERY_FAILED",
            `Persisted memory embedding ${parsedRecord.object_id} could not be reloaded.`
          );
        }

        return parseMemoryEmbeddingRow(persisted);
      }
    );
  }

  public async upsert(record: MemoryEmbeddingRecord): Promise<Readonly<MemoryEmbeddingRecord>> {
    const parsedRecord = parseMemoryEmbeddingRecord(record);

    try {
      this.runUpsert(parsedRecord);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to persist memory embedding for ${parsedRecord.object_id}.`,
        error
      );
    }

    const persisted = await this.findByObjectId(parsedRecord.object_id);
    if (persisted === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted memory embedding ${parsedRecord.object_id} could not be reloaded.`
      );
    }

    return persisted;
  }

  public async upsertIfContentHashMatchesCurrentMemory(
    record: MemoryEmbeddingRecord
  ): Promise<Readonly<MemoryEmbeddingRecord> | null> {
    const parsedRecord = parseMemoryEmbeddingRecord(record);

    try {
      return this.guardedUpsertTransaction(parsedRecord);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed guarded memory embedding write for ${parsedRecord.object_id}.`,
        error
      );
    }
  }

  private runUpsert(parsedRecord: Readonly<MemoryEmbeddingRecord>): void {
    this.upsertStatement.run(...runUpsertArgs(parsedRecord));
  }

  public async findByObjectId(objectId: string): Promise<Readonly<MemoryEmbeddingRecord> | null> {
    const parsedObjectId = parseObjectId(objectId);

    try {
      const row = this.findByObjectIdStatement.get(parsedObjectId) as MemoryEmbeddingRow | undefined;
      return row === undefined ? null : parseMemoryEmbeddingRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load memory embedding ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findMetadataByObjectIds(
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEmbeddingMetadata>[]> {
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseObjectId(objectId))));
    if (parsedObjectIds.length === 0) {
      return Object.freeze([]);
    }

    try {
      const rows: MemoryEmbeddingMetadataRow[] = [];
      for (const chunk of chunkObjectIds(parsedObjectIds)) {
        const placeholders = chunk.map(() => "?").join(", ");
        const statement = this.db.connection.prepare(`
          SELECT${MEMORY_EMBEDDING_METADATA_COLUMNS}
          FROM memory_embeddings
          WHERE object_id IN (${placeholders})
        `);
        rows.push(...(statement.all(...chunk) as MemoryEmbeddingMetadataRow[]));
      }
      return Object.freeze(
        rows
          .map((row) => parseMemoryEmbeddingMetadataRow(row))
          .sort((left, right) => left.object_id.localeCompare(right.object_id))
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load memory embedding metadata.",
        error
      );
    }
  }

  public async listByWorkspace(
    workspaceId: string,
    options?: MemoryEmbeddingListByWorkspaceOptions
  ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const tierFilter = options?.tierFilter;
    const limit = options?.limit;
    const providerKind = options?.providerKind;
    const modelId = options?.modelId;

    try {
      if (
        tierFilter === undefined &&
        (limit === undefined || limit <= 0) &&
        providerKind === undefined &&
        modelId === undefined
      ) {
        const rows = this.listByWorkspaceStatement.all(parsedWorkspaceId) as MemoryEmbeddingRow[];
        return Object.freeze(rows.map((row) => parseMemoryEmbeddingRow(row)));
      }

      const clauses: string[] = ["e.workspace_id = ?"];
      const args: (string | number)[] = [parsedWorkspaceId];
      if (tierFilter !== undefined && tierFilter.length > 0) {
        const placeholders = tierFilter.map(() => "?").join(", ");
        clauses.push(`m.storage_tier IN (${placeholders})`);
        for (const tier of tierFilter) {
          args.push(tier);
        }
      }
      if (providerKind !== undefined) {
        clauses.push("e.provider_kind = ?");
        args.push(parseProviderKind(providerKind));
      }
      if (modelId !== undefined) {
        clauses.push("e.model_id = ?");
        args.push(parseModelId(modelId));
      }
      let sql = `
        SELECT
          e.object_id,
          e.workspace_id,
          e.content_hash,
          e.provider_kind,
          e.model_id,
          e.schema_version,
          e.dimensions,
          e.embedding_blob,
          e.created_at,
          e.updated_at
        FROM memory_embeddings e
        INNER JOIN memory_entries m ON m.object_id = e.object_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.object_id ASC
      `;
      if (limit !== undefined && limit > 0) {
        sql += " LIMIT ?";
        args.push(Math.floor(limit));
      }
      const statement = this.db.connection.prepare(sql);
      const rows = statement.all(...args) as MemoryEmbeddingRow[];
      return Object.freeze(rows.map((row) => parseMemoryEmbeddingRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list memory embeddings for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async listByObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseObjectId(objectId))));

    if (parsedObjectIds.length === 0) {
      return Object.freeze([]);
    }

    try {
      const rows: MemoryEmbeddingRow[] = [];
      for (const chunk of chunkObjectIds(parsedObjectIds)) {
        const placeholders = chunk.map(() => "?").join(", ");
        const statement = this.db.connection.prepare(`
          SELECT${MEMORY_EMBEDDING_SELECT_COLUMNS}
          FROM memory_embeddings
          WHERE workspace_id = ?
            AND object_id IN (${placeholders})
        `);
        rows.push(...(statement.all(parsedWorkspaceId, ...chunk) as MemoryEmbeddingRow[]));
      }
      return Object.freeze(
        rows
          .map((row) => parseMemoryEmbeddingRow(row))
          .sort((left, right) => left.object_id.localeCompare(right.object_id))
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list filtered memory embeddings for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function chunkObjectIds(objectIds: readonly string[]): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  for (let offset = 0; offset < objectIds.length; offset += MEMORY_EMBEDDING_OBJECT_ID_CHUNK_SIZE) {
    chunks.push(objectIds.slice(offset, offset + MEMORY_EMBEDDING_OBJECT_ID_CHUNK_SIZE));
  }
  return chunks;
}

function hashMemoryContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function runUpsertArgs(parsedRecord: Readonly<MemoryEmbeddingRecord>): [
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

function parseMemoryEmbeddingRecord(value: MemoryEmbeddingRecord): Readonly<MemoryEmbeddingRecord> {
  const embedding = parseEmbedding(value.embedding, "embedding");
  const dimensions = parseDimensions(value.dimensions);

  if (embedding.length !== dimensions) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Embedding length ${embedding.length} did not match declared dimensions ${dimensions}.`
    );
  }

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

function parseMemoryEmbeddingRow(row: MemoryEmbeddingRow): Readonly<MemoryEmbeddingRecord> {
  const embedding = deserializeEmbedding(row.embedding_blob, row.dimensions);

  return parseMemoryEmbeddingRecord({
    object_id: row.object_id,
    workspace_id: row.workspace_id,
    content_hash: row.content_hash,
    provider_kind: row.provider_kind,
    model_id: row.model_id,
    schema_version: row.schema_version,
    dimensions: row.dimensions,
    embedding,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function parseMemoryEmbeddingMetadataRow(
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
  const copy = new Float32Array(embedding);
  return Buffer.from(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength));
}

function deserializeEmbedding(blob: Buffer, dimensions: number): Float32Array {
  const expectedByteLength = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (blob.byteLength !== expectedByteLength) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Embedding blob size ${blob.byteLength} did not match dimensions ${dimensions}.`
    );
  }

  const copiedBytes = Uint8Array.from(blob);
  return new Float32Array(copiedBytes.buffer);
}

function parseEmbedding(value: Float32Array, fieldName: string): Float32Array {
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

  return new Float32Array(value);
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

const parseObjectId = (value: string): string => parseNonEmptyString(value, "object_id");
const parseWorkspaceId = (value: string): string => parseNonEmptyString(value, "workspace_id");
const parseContentHash = (value: string): string => parseNonEmptyString(value, "content_hash");
const parseProviderKind = (value: string): string => parseNonEmptyString(value, "provider_kind");
const parseModelId = (value: string): string => parseNonEmptyString(value, "model_id");
