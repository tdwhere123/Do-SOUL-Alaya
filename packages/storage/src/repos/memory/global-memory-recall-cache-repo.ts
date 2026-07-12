import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parseNonEmptyString,
  parsePageLimit,
  parsePageOffset,
  parseTimestamp
} from "../shared/validators.js";

const classificationValues = ["included", "excluded"] as const;

export type GlobalMemoryRecallClassification = (typeof classificationValues)[number];
export interface GlobalMemoryRecallCacheRecord {
  readonly workspace_id: string;
  readonly global_object_id: string;
  readonly classification: GlobalMemoryRecallClassification;
  readonly updated_at: string;
}

export interface GlobalMemoryRecallCacheRepo {
  upsert(record: GlobalMemoryRecallCacheRecord): Promise<Readonly<GlobalMemoryRecallCacheRecord>>;
  upsertMany(
    records: readonly Readonly<GlobalMemoryRecallCacheRecord>[]
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
  listByWorkspace(
    workspaceId: string,
    classification?: GlobalMemoryRecallClassification
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
  listByWorkspacePage?(
    workspaceId: string,
    classification: GlobalMemoryRecallClassification | undefined,
    page: GlobalMemoryRecallCachePageOptions
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
  listByWorkspaceAll?(
    workspaceId: string,
    classification?: GlobalMemoryRecallClassification
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
}

export interface GlobalMemoryRecallCachePageOptions {
  readonly limit: number;
  readonly offset: number;
}

interface GlobalMemoryRecallCacheRow {
  readonly workspace_id: string;
  readonly global_object_id: string;
  readonly classification: string;
  readonly updated_at: string;
}

const DEFAULT_GLOBAL_RECALL_CACHE_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

const GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS = `
      workspace_id,
      global_object_id,
      classification,
      updated_at
`;

export class SqliteGlobalMemoryRecallCacheRepo implements GlobalMemoryRecallCacheRepo {
  private readonly upsertStatement;
  private readonly getByWorkspaceAndObjectIdStatement;
  private readonly listByWorkspaceStatement;
  private readonly listByWorkspacePagedStatement;
  private readonly listByWorkspaceAndClassificationStatement;
  private readonly listByWorkspaceAndClassificationPagedStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.upsertStatement = db.connection.prepare(`
      INSERT INTO global_memory_recall_cache (
        workspace_id,
        global_object_id,
        classification,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, global_object_id) DO UPDATE SET
        classification = excluded.classification,
        updated_at = excluded.updated_at
    `);
    this.getByWorkspaceAndObjectIdStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ? AND global_object_id = ?
      LIMIT 1
    `);

    this.listByWorkspaceStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ?
      ORDER BY global_object_id ASC
    `);
    this.listByWorkspacePagedStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ?
      ORDER BY global_object_id ASC
      LIMIT ? OFFSET ?
    `);

    this.listByWorkspaceAndClassificationStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ? AND classification = ?
      ORDER BY global_object_id ASC
    `);
    this.listByWorkspaceAndClassificationPagedStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ? AND classification = ?
      ORDER BY global_object_id ASC
      LIMIT ? OFFSET ?
    `);
  }

  public async upsert(
    record: GlobalMemoryRecallCacheRecord
  ): Promise<Readonly<GlobalMemoryRecallCacheRecord>> {
    const parsedRecord = parseGlobalMemoryRecallCacheRecord(record);

    try {
      this.upsertStatement.run(
        parsedRecord.workspace_id,
        parsedRecord.global_object_id,
        parsedRecord.classification,
        parsedRecord.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to persist global memory recall cache for ${parsedRecord.workspace_id}/${parsedRecord.global_object_id}.`,
        error
      );
    }

    const persistedRecord = this.getByWorkspaceAndObjectId(
      parsedRecord.workspace_id,
      parsedRecord.global_object_id
    );

    if (persistedRecord === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted global memory recall cache for ${parsedRecord.workspace_id}/${parsedRecord.global_object_id} could not be reloaded.`
      );
    }

    return persistedRecord;
  }

  public async upsertMany(
    records: readonly Readonly<GlobalMemoryRecallCacheRecord>[]
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]> {
    if (records.length === 0) {
      return Object.freeze([]);
    }

    const parsedRecords = records.map((record) => parseGlobalMemoryRecallCacheRecord(record));
    const workspaceIds = new Set(parsedRecords.map((record) => record.workspace_id));

    if (workspaceIds.size !== 1) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Global memory recall cache batches must target exactly one workspace."
      );
    }

    const workspaceId = parsedRecords[0]?.workspace_id;
    if (workspaceId === undefined) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Global memory recall cache batch must contain at least one record."
      );
    }

    try {
      this.db.connection.transaction((batch: readonly Readonly<GlobalMemoryRecallCacheRecord>[]) => {
        for (const record of batch) {
          this.upsertStatement.run(
            record.workspace_id,
            record.global_object_id,
            record.classification,
            record.updated_at
          );
        }
      })(parsedRecords);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to persist global memory recall cache batch for workspace ${workspaceId}.`,
        error
      );
    }

    return this.listByWorkspaceAndObjectIds(
      workspaceId,
      parsedRecords.map((record) => record.global_object_id)
    );
  }

  public async listByWorkspace(
    workspaceId: string,
    classification?: GlobalMemoryRecallClassification
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]> {
    return await this.listByWorkspacePage(workspaceId, classification, DEFAULT_GLOBAL_RECALL_CACHE_PAGE);
  }

  public async listByWorkspacePage(
    workspaceId: string,
    classification: GlobalMemoryRecallClassification | undefined,
    page: GlobalMemoryRecallCachePageOptions
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const parsedClassification =
      classification === undefined ? undefined : parseClassification(classification);
    const parsedPage = parseGlobalRecallCachePage(page);

    try {
      const rows =
        parsedClassification === undefined
          ? (this.listByWorkspacePagedStatement.all(
              parsedWorkspaceId,
              parsedPage.limit,
              parsedPage.offset
            ) as GlobalMemoryRecallCacheRow[])
          : (this.listByWorkspaceAndClassificationPagedStatement.all(
              parsedWorkspaceId,
              parsedClassification,
              parsedPage.limit,
              parsedPage.offset
            ) as GlobalMemoryRecallCacheRow[]);

      return rows.map((row) => parseGlobalMemoryRecallCacheRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list paged global memory recall cache rows for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async listByWorkspaceAll(
    workspaceId: string,
    classification?: GlobalMemoryRecallClassification
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const parsedClassification =
      classification === undefined ? undefined : parseClassification(classification);

    try {
      const rows =
        parsedClassification === undefined
          ? (this.listByWorkspaceStatement.all(parsedWorkspaceId) as GlobalMemoryRecallCacheRow[])
          : (this.listByWorkspaceAndClassificationStatement.all(
              parsedWorkspaceId,
              parsedClassification
            ) as GlobalMemoryRecallCacheRow[]);

      return rows.map((row) => parseGlobalMemoryRecallCacheRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list all global memory recall cache rows for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  private getByWorkspaceAndObjectId(
    workspaceId: string,
    globalObjectId: string
  ): Readonly<GlobalMemoryRecallCacheRecord> | null {
    try {
      const row = this.getByWorkspaceAndObjectIdStatement.get(workspaceId, globalObjectId) as
        | GlobalMemoryRecallCacheRow
        | undefined;
      return row === undefined ? null : parseGlobalMemoryRecallCacheRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to reload global memory recall cache for ${workspaceId}/${globalObjectId}.`,
        error
      );
    }
  }

  private listByWorkspaceAndObjectIds(
    workspaceId: string,
    globalObjectIds: readonly string[]
  ): readonly Readonly<GlobalMemoryRecallCacheRecord>[] {
    const uniqueIds = [...new Set(globalObjectIds.map((value) => parseGlobalObjectId(value)))];
    if (uniqueIds.length === 0) {
      return Object.freeze([]);
    }

    const placeholders = uniqueIds.map(() => "?").join(", ");
    try {
      const statement = this.db.connection.prepare(`
        SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
        FROM global_memory_recall_cache
        WHERE workspace_id = ?
          AND global_object_id IN (${placeholders})
        ORDER BY global_object_id ASC
      `);
      const rows = statement.all(workspaceId, ...uniqueIds) as GlobalMemoryRecallCacheRow[];
      return Object.freeze(rows.map((row) => parseGlobalMemoryRecallCacheRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to reload global memory recall cache batch for workspace ${workspaceId}.`,
        error
      );
    }
  }
}

function parseGlobalMemoryRecallCacheRecord(
  value: GlobalMemoryRecallCacheRecord
): Readonly<GlobalMemoryRecallCacheRecord> {
  return deepFreeze({
    workspace_id: parseWorkspaceId(value.workspace_id),
    global_object_id: parseGlobalObjectId(value.global_object_id),
    classification: parseClassification(value.classification),
    updated_at: parseTimestamp(value.updated_at)
  });
}

function parseGlobalMemoryRecallCacheRow(
  row: GlobalMemoryRecallCacheRow
): Readonly<GlobalMemoryRecallCacheRecord> {
  return parseGlobalMemoryRecallCacheRecord({
    workspace_id: row.workspace_id,
    global_object_id: row.global_object_id,
    classification: row.classification as GlobalMemoryRecallClassification,
    updated_at: row.updated_at
  });
}

function parseGlobalRecallCachePage(
  page: GlobalMemoryRecallCachePageOptions
): Readonly<GlobalMemoryRecallCachePageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "global memory recall cache page limit"),
    offset: parsePageOffset(page.offset, "global memory recall cache page offset")
  });
}

function parseClassification(value: string): GlobalMemoryRecallClassification {
  if (value === "included" || value === "excluded") {
    return value;
  }

  throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory recall classification.");
}

const parseWorkspaceId = (value: string): string => parseNonEmptyString(value, "workspace_id");
const parseGlobalObjectId = (value: string): string => parseNonEmptyString(value, "global_object_id");
