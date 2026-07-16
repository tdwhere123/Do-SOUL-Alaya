import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseOptionalRow, parseRows, readRecord } from "../shared/parse-row.js";
import {
  MemoryEmbeddingMetadataRowParser,
  MemoryEmbeddingRowParser
} from "../shared/sqlite-row-schemas.js";
import {
  MEMORY_EMBEDDING_METADATA_COLUMNS,
  chunkObjectIds,
  hashMemoryContent,
  parseMemoryEmbeddingMetadataRow,
  parseMemoryEmbeddingRecord,
  parseMemoryEmbeddingRow,
  parseModelId,
  parseObjectId,
  parseProviderKind,
  parseWorkspaceId,
  runUpsertArgs,
  type MemoryEmbeddingMetadataRow
} from "./memory-embedding-mappers.js";
import {
  prepareMemoryEmbeddingStatements,
  type SqliteStatement
} from "./memory-embedding-statements.js";

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
// see also: packages/core/src/embedding-recall/embedding-backfill-handler.ts EmbeddingBackfillRepoPort
export interface MemoryEmbeddingMetadata {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content_hash: string;
  readonly provider_kind: string;
  readonly model_id: string;
  readonly schema_version: number;
  readonly dimensions: number;
  readonly vector_valid: boolean;
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
  // invariant: cosine space is valid only within one embedding schema_version.
  readonly schemaVersion?: number;
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

interface MemoryEmbeddingWorkspaceQuery {
  readonly sql: string;
  readonly args: readonly (string | number)[];
}

export class SqliteMemoryEmbeddingRepo implements MemoryEmbeddingRepo {
  private readonly upsertStatement: SqliteStatement;
  private readonly findByObjectIdStatement: SqliteStatement;
  private readonly listByWorkspaceStatement: SqliteStatement;
  private readonly findCurrentMemoryContentStatement: SqliteStatement;
  private readonly listByObjectIdFilterStatement: SqliteStatement;
  private readonly guardedUpsertTransaction: (
    parsedRecord: Readonly<MemoryEmbeddingRecord>
  ) => Readonly<MemoryEmbeddingRecord> | null;

  public constructor(private readonly db: StorageDatabase) {
    const statements = prepareMemoryEmbeddingStatements(db);
    this.upsertStatement = statements.upsertStatement;
    this.findByObjectIdStatement = statements.findByObjectIdStatement;
    this.listByWorkspaceStatement = statements.listByWorkspaceStatement;
    this.findCurrentMemoryContentStatement = statements.findCurrentMemoryContentStatement;
    this.listByObjectIdFilterStatement = statements.listByObjectIdFilterStatement;
    this.guardedUpsertTransaction = this.createGuardedUpsertTransaction();
  }

  private createGuardedUpsertTransaction(): (
    parsedRecord: Readonly<MemoryEmbeddingRecord>
  ) => Readonly<MemoryEmbeddingRecord> | null {
    return this.db.connection.transaction((parsedRecord: Readonly<MemoryEmbeddingRecord>) => {
      const currentMemory = parseMemoryContentProbe(
        this.findCurrentMemoryContentStatement.get(parsedRecord.object_id, parsedRecord.workspace_id)
      );

      if (currentMemory === null || hashMemoryContent(currentMemory.content) !== parsedRecord.content_hash) {
        return null;
      }

      this.runUpsert(parsedRecord);
      return this.findRequiredPersistedEmbedding(parsedRecord.object_id);
    });
  }

  private findRequiredPersistedEmbedding(objectId: string): Readonly<MemoryEmbeddingRecord> {
    const persisted = parseOptionalRow(
      this.findByObjectIdStatement.get(objectId),
      MemoryEmbeddingRowParser,
      "memory embedding row"
    );
    if (persisted === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted memory embedding ${objectId} could not be reloaded.`
      );
    }
    return parseMemoryEmbeddingRow(persisted);
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
      const row = parseOptionalRow(
        this.findByObjectIdStatement.get(parsedObjectId),
        MemoryEmbeddingRowParser,
        "memory embedding row"
      );
      return row === null ? null : parseMemoryEmbeddingRow(row);
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
        rows.push(
          ...parseRows(statement.all(...chunk), MemoryEmbeddingMetadataRowParser, "memory embedding metadata row")
        );
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

    try {
      if (usesDefaultWorkspaceEmbeddingQuery(options)) {
        const rows = parseRows(
          this.listByWorkspaceStatement.all(parsedWorkspaceId),
          MemoryEmbeddingRowParser,
          "memory embedding row"
        );
        return Object.freeze(rows.map((row) => parseMemoryEmbeddingRow(row)));
      }

      const query = buildWorkspaceEmbeddingQuery(parsedWorkspaceId, options);
      const rows = parseRows(
        this.db.connection.prepare(query.sql).all(...query.args),
        MemoryEmbeddingRowParser,
        "memory embedding row"
      );
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
      const rows = parseRows(
        this.listByObjectIdFilterStatement.all(JSON.stringify(parsedObjectIds), parsedWorkspaceId),
        MemoryEmbeddingRowParser,
        "memory embedding row"
      );
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

function usesDefaultWorkspaceEmbeddingQuery(
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): boolean {
  return (
    options?.tierFilter === undefined &&
    (options?.limit === undefined || options.limit <= 0) &&
    options?.providerKind === undefined &&
    options?.modelId === undefined &&
    options?.schemaVersion === undefined
  );
}

function buildWorkspaceEmbeddingQuery(
  workspaceId: string,
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): MemoryEmbeddingWorkspaceQuery {
  const clauses = [
    "e.workspace_id = ?",
    "e.vector_valid = 1",
    "m.lifecycle_state = 'active'",
    "COALESCE(m.retention_state, '') != 'tombstoned'"
  ];
  const args: (string | number)[] = [workspaceId];
  appendWorkspaceEmbeddingFilters(clauses, args, options);
  let sql = `${WORKSPACE_EMBEDDING_SELECT_SQL}
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.object_id ASC`;
  if (options?.limit !== undefined && options.limit > 0) {
    sql += " LIMIT ?";
    args.push(Math.floor(options.limit));
  }
  return { sql, args };
}

function appendWorkspaceEmbeddingFilters(
  clauses: string[],
  args: (string | number)[],
  options: MemoryEmbeddingListByWorkspaceOptions | undefined
): void {
  appendTierFilter(clauses, args, options?.tierFilter);
  if (options?.providerKind !== undefined) {
    clauses.push("e.provider_kind = ?");
    args.push(parseProviderKind(options.providerKind));
  }
  if (options?.modelId !== undefined) {
    clauses.push("e.model_id = ?");
    args.push(parseModelId(options.modelId));
  }
  if (options?.schemaVersion !== undefined) {
    clauses.push("e.schema_version = ?");
    args.push(Math.floor(options.schemaVersion));
  }
}

function appendTierFilter(
  clauses: string[],
  args: (string | number)[],
  tierFilter: readonly ("hot" | "warm" | "cold")[] | undefined
): void {
  if (tierFilter === undefined || tierFilter.length === 0) {
    return;
  }
  clauses.push(`m.storage_tier IN (${tierFilter.map(() => "?").join(", ")})`);
  args.push(...tierFilter);
}

const WORKSPACE_EMBEDDING_SELECT_SQL = `
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
        INNER JOIN memory_entries m ON m.object_id = e.object_id`;

function parseMemoryContentProbe(value: unknown): { readonly content: string } | null {
  if (value === undefined || value === null) {
    return null;
  }

  const record = readRecord(value, "memory content row");
  const content = record.content;
  if (typeof content !== "string") {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate content.");
  }
  if (content.length === 0) {
    return null;
  }

  return { content };
}
