import { EngineBindingRecordSchema, type EngineBindingRecord } from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

export type EngineBindingRecordCreateInput = Omit<EngineBindingRecord, "created_at" | "updated_at">;

export interface EngineBindingRepo {
  upsert(data: EngineBindingRecordCreateInput): Promise<EngineBindingRecord>;
  getById(id: string): Promise<EngineBindingRecord | null>;
  listByWorkspace(workspaceId: string): Promise<readonly EngineBindingRecord[]>;
}

interface EngineBindingRow {
  readonly binding_id: string;
  readonly workspace_id: string;
  readonly provider_type: string;
  readonly base_url: string | null;
  readonly api_key: string;
  readonly model: string;
  readonly config_json: string;
  readonly enable_tools: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export class SqliteEngineBindingRepo implements EngineBindingRepo {
  private readonly getByIdStatement;
  private readonly listByWorkspaceStatement;
  private readonly upsertStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.getByIdStatement = db.connection.prepare(`
      SELECT
        binding_id,
        workspace_id,
        provider_type,
        base_url,
        api_key,
        model,
        config_json,
        enable_tools,
        created_at,
        updated_at
      FROM engine_bindings
      WHERE binding_id = ?
      LIMIT 1
    `);
    this.listByWorkspaceStatement = db.connection.prepare(`
      SELECT
        binding_id,
        workspace_id,
        provider_type,
        base_url,
        api_key,
        model,
        config_json,
        enable_tools,
        created_at,
        updated_at
      FROM engine_bindings
      WHERE workspace_id = ?
      ORDER BY created_at ASC, binding_id ASC
    `);
    this.upsertStatement = db.connection.prepare(`
      INSERT INTO engine_bindings (
        binding_id,
        workspace_id,
        provider_type,
        base_url,
        api_key,
        model,
        config_json,
        enable_tools,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        provider_type = excluded.provider_type,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        model = excluded.model,
        config_json = excluded.config_json,
        enable_tools = excluded.enable_tools,
        updated_at = excluded.updated_at
    `);
  }

  public async upsert(data: EngineBindingRecordCreateInput): Promise<EngineBindingRecord> {
    const existing = await this.getById(data.binding_id);
    const now = new Date().toISOString();
    const record = parseEngineBindingRecord({
      ...data,
      created_at: existing?.created_at ?? now,
      updated_at: now
    });

    try {
      this.upsertStatement.run(
        record.binding_id,
        record.workspace_id,
        record.provider_type,
        record.base_url,
        record.api_key,
        record.model,
        JSON.stringify(record.config),
        record.enable_tools !== undefined ? (record.enable_tools ? 1 : 0) : null,
        record.created_at,
        record.updated_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to save engine binding ${record.binding_id}.`, error);
    }

    return record;
  }

  public async getById(id: string): Promise<EngineBindingRecord | null> {
    try {
      const row = this.getByIdStatement.get(id) as EngineBindingRow | undefined;
      return row === undefined ? null : parseEngineBindingRecord(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load engine binding ${id}.`, error);
    }
  }

  public async listByWorkspace(workspaceId: string): Promise<readonly EngineBindingRecord[]> {
    try {
      const rows = this.listByWorkspaceStatement.all(workspaceId) as EngineBindingRow[];
      return rows.map((row) => parseEngineBindingRecord(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list engine bindings for workspace ${workspaceId}.`, error);
    }
  }
}

function parseEngineBindingRecord(row: EngineBindingRow | EngineBindingRecord): EngineBindingRecord {
  const rawConfig = "config_json" in row ? row.config_json : JSON.stringify(row.config);
  const enableTools = "enable_tools" in row && row.enable_tools !== null && row.enable_tools !== undefined
    ? typeof row.enable_tools === "number" ? row.enable_tools === 1 : row.enable_tools
    : undefined;

  try {
    return EngineBindingRecordSchema.parse({
      binding_id: row.binding_id,
      workspace_id: row.workspace_id,
      provider_type: row.provider_type,
      base_url: row.base_url,
      api_key: row.api_key,
      model: row.model,
      config: JSON.parse(rawConfig) as Record<string, unknown>,
      ...(enableTools !== undefined ? { enable_tools: enableTools } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate engine binding row.", error);
  }
}
