import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export interface MemoryHqRecord {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly hqs: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemoryHqRepo {
  upsert(record: MemoryHqRecord): Promise<void>;
  getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { readonly changes: number };
}

interface MemoryHqRow {
  readonly object_id: string;
  readonly hqs_json: string;
}

// SQLite bind-variable ceiling is 999; chunk lookups well under it.
const HQ_LOOKUP_CHUNK = 500;

export class SqliteMemoryHqRepo implements MemoryHqRepo {
  private readonly upsertStatement: SqliteStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.upsertStatement = db.connection.prepare(UPSERT_MEMORY_HQ_SQL);
  }

  public async upsert(record: MemoryHqRecord): Promise<void> {
    try {
      this.upsertStatement.run(
        record.object_id,
        record.workspace_id,
        JSON.stringify(record.hqs),
        record.created_at,
        record.updated_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to persist memory HQ for ${record.object_id}.`, error);
    }
  }

  public async getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const unique = Array.from(new Set(objectIds));
    const result = new Map<string, readonly string[]>();
    if (unique.length === 0) {
      return result;
    }

    try {
      for (let offset = 0; offset < unique.length; offset += HQ_LOOKUP_CHUNK) {
        const chunk = unique.slice(offset, offset + HQ_LOOKUP_CHUNK);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = this.db.connection
          .prepare(`SELECT object_id, hqs_json FROM memory_hq WHERE object_id IN (${placeholders})`)
          .all(...chunk) as MemoryHqRow[];
        for (const row of rows) {
          const hqs = parseHqs(row.hqs_json);
          if (hqs.length > 0) {
            result.set(row.object_id, hqs);
          }
        }
      }
      return result;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load memory HQ rows.", error);
    }
  }
}

function parseHqs(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

const UPSERT_MEMORY_HQ_SQL = `
      INSERT INTO memory_hq (
        object_id,
        workspace_id,
        hqs_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        hqs_json = excluded.hqs_json,
        updated_at = excluded.updated_at
`;
