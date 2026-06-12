import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

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
}

interface GlobalMemoryRecallCacheRow {
  readonly workspace_id: string;
  readonly global_object_id: string;
  readonly classification: string;
  readonly updated_at: string;
}

const GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS = `
      workspace_id,
      global_object_id,
      classification,
      updated_at
`;

export class SqliteGlobalMemoryRecallCacheRepo implements GlobalMemoryRecallCacheRepo {
  private readonly upsertStatement;
  private readonly listByWorkspaceStatement;
  private readonly listByWorkspaceAndClassificationStatement;

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

    this.listByWorkspaceStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ?
      ORDER BY global_object_id ASC
    `);

    this.listByWorkspaceAndClassificationStatement = db.connection.prepare(`
      SELECT${GLOBAL_MEMORY_RECALL_CACHE_SELECT_COLUMNS}
      FROM global_memory_recall_cache
      WHERE workspace_id = ? AND classification = ?
      ORDER BY global_object_id ASC
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

    const persistedRecords = await this.listByWorkspace(parsedRecord.workspace_id);
    const persistedRecord =
      persistedRecords.find((entry) => entry.global_object_id === parsedRecord.global_object_id) ?? null;

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
        `Failed to persist global memory recall cache batch for workspace ${parsedRecords[0]!.workspace_id}.`,
        error
      );
    }

    const persistedRecords = await this.listByWorkspace(parsedRecords[0]!.workspace_id);
    const requestedIds = new Set(parsedRecords.map((record) => record.global_object_id));

    return Object.freeze(
      persistedRecords.filter((record) => requestedIds.has(record.global_object_id))
    );
  }

  public async listByWorkspace(
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
        `Failed to list global memory recall cache rows for workspace ${parsedWorkspaceId}.`,
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

function parseClassification(value: string): GlobalMemoryRecallClassification {
  if (value === "included" || value === "excluded") {
    return value;
  }

  throw new StorageError("VALIDATION_FAILED", "Failed to validate global memory recall classification.");
}

const parseWorkspaceId = (value: string): string => parseNonEmptyString(value, "workspace_id");
const parseGlobalObjectId = (value: string): string => parseNonEmptyString(value, "global_object_id");
