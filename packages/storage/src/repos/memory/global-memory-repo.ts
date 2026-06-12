import {
  GlobalMemoryEntrySchema,
  MemoryDimensionSchema,
  ScopeClassSchema,
  type GlobalMemoryEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";

export interface GlobalMemoryRepoListFilters {
  readonly dimension?: GlobalMemoryEntry["dimension"];
  readonly scope_class?: GlobalMemoryEntry["scope_class"];
}

export interface GlobalMemoryRepo {
  upsert(entry: GlobalMemoryEntry): Promise<Readonly<GlobalMemoryEntry>>;
  findByGlobalObjectId(globalObjectId: string): Promise<Readonly<GlobalMemoryEntry> | null>;
  list(filters?: GlobalMemoryRepoListFilters): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
}

interface GlobalMemoryEntryRow {
  readonly global_object_id: string;
  readonly object_kind: string;
  readonly canonical_identity: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: string;
  readonly provenance: string;
  readonly activation_score: number | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const GLOBAL_MEMORY_ENTRY_SELECT_COLUMNS = `
      global_object_id,
      object_kind,
      canonical_identity,
      dimension,
      scope_class,
      content,
      domain_tags,
      provenance,
      activation_score,
      version,
      created_at,
      updated_at
`;

export class SqliteGlobalMemoryRepo implements GlobalMemoryRepo {
  private readonly upsertStatement;
  private readonly findByGlobalObjectIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.upsertStatement = db.connection.prepare(`
      INSERT INTO global_memory_entries (
        global_object_id,
        object_kind,
        canonical_identity,
        dimension,
        scope_class,
        content,
        domain_tags,
        provenance,
        activation_score,
        version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(global_object_id) DO UPDATE SET
        object_kind = excluded.object_kind,
        canonical_identity = excluded.canonical_identity,
        dimension = excluded.dimension,
        scope_class = excluded.scope_class,
        content = excluded.content,
        domain_tags = excluded.domain_tags,
        provenance = excluded.provenance,
        activation_score = excluded.activation_score,
        version = excluded.version,
        updated_at = excluded.updated_at
    `);

    this.findByGlobalObjectIdStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM global_memory_entries
      WHERE global_object_id = ?
      LIMIT 1
    `);
  }

  public async upsert(entry: GlobalMemoryEntry): Promise<Readonly<GlobalMemoryEntry>> {
    const parsedEntry = parseGlobalMemoryEntry(entry);

    try {
      this.upsertStatement.run(
        parsedEntry.global_object_id,
        parsedEntry.object_kind,
        parsedEntry.canonical_identity,
        parsedEntry.dimension,
        parsedEntry.scope_class,
        parsedEntry.content,
        JSON.stringify(parsedEntry.domain_tags),
        parsedEntry.provenance,
        parsedEntry.activation_score,
        parsedEntry.version,
        parsedEntry.created_at,
        parsedEntry.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to persist global memory entry ${parsedEntry.global_object_id}.`,
        error
      );
    }

    const persistedEntry = await this.findByGlobalObjectId(parsedEntry.global_object_id);
    if (persistedEntry === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted global memory entry ${parsedEntry.global_object_id} could not be reloaded.`
      );
    }

    return persistedEntry;
  }

  public async findByGlobalObjectId(
    globalObjectId: string
  ): Promise<Readonly<GlobalMemoryEntry> | null> {
    const parsedGlobalObjectId = parseGlobalObjectId(globalObjectId);

    try {
      const row = this.findByGlobalObjectIdStatement.get(parsedGlobalObjectId) as
        | GlobalMemoryEntryRow
        | undefined;
      return row === undefined ? null : parseGlobalMemoryEntryRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load global memory entry ${parsedGlobalObjectId}.`,
        error
      );
    }
  }

  public async list(
    filters: GlobalMemoryRepoListFilters = {}
  ): Promise<readonly Readonly<GlobalMemoryEntry>[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters.dimension !== undefined) {
      conditions.push("dimension = ?");
      values.push(parseDimension(filters.dimension));
    }

    if (filters.scope_class !== undefined) {
      conditions.push("scope_class = ?");
      values.push(parseScopeClass(filters.scope_class));
    }

    const whereClause = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const statement = this.db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_ENTRY_SELECT_COLUMNS}
      FROM global_memory_entries
      ${whereClause}
      ORDER BY global_object_id ASC
    `);

    try {
      const rows = statement.all(...values) as GlobalMemoryEntryRow[];
      return rows.map((row) => parseGlobalMemoryEntryRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to list global memory entries.", error);
    }
  }
}

function parseGlobalMemoryEntry(value: GlobalMemoryEntry): Readonly<GlobalMemoryEntry> {
  try {
    return deepFreeze(GlobalMemoryEntrySchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory entry.", error);
  }
}

function parseGlobalMemoryEntryRow(row: GlobalMemoryEntryRow): Readonly<GlobalMemoryEntry> {
  try {
    return deepFreeze(
      GlobalMemoryEntrySchema.parse({
        global_object_id: row.global_object_id,
        object_kind: row.object_kind,
        canonical_identity: row.canonical_identity,
        dimension: row.dimension,
        scope_class: row.scope_class,
        content: row.content,
        domain_tags: parseDomainTags(row.domain_tags),
        provenance: row.provenance,
        activation_score: row.activation_score,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory entry row.", error);
  }
}

function parseDomainTags(value: string): readonly string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse global memory entry domain_tags.", error);
  }

  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string" || tag.trim().length === 0)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory entry domain_tags.");
  }

  return parsed;
}

function parseDimension(value: GlobalMemoryEntry["dimension"]): GlobalMemoryEntry["dimension"] {
  try {
    return MemoryDimensionSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory dimension.", error);
  }
}

function parseScopeClass(value: GlobalMemoryEntry["scope_class"]): GlobalMemoryEntry["scope_class"] {
  try {
    return ScopeClassSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory scope_class.", error);
  }
}

const parseGlobalObjectId = (value: string): string => parseNonEmptyString(value, "global_object_id");
