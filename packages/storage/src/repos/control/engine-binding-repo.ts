import { EngineBindingRecordSchema, type EngineBindingRecord } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import {
  decryptApiKeyAtRest,
  encryptApiKeyAtRest
} from "../shared/api-key-cipher.js";

export type EngineBindingRecordCreateInput = Omit<EngineBindingRecord, "created_at" | "updated_at">;

export interface EngineBindingRepo {
  upsert(data: EngineBindingRecordCreateInput): EngineBindingRecord;
  getById(id: string): Promise<EngineBindingRecord | null>;
  listByWorkspace(workspaceId: string): Promise<readonly EngineBindingRecord[]>;
}

interface EngineBindingRow {
  readonly binding_id: string;
  readonly workspace_id: string;
  readonly provider_type: string;
  readonly base_url: string | null;
  readonly api_key: string;
  readonly api_key_ref: string | null;
  readonly model: string;
  readonly config_json: string;
  readonly enable_tools: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EngineBindingStatements {
  readonly getByIdStatement: {
    get(...args: readonly unknown[]): unknown;
  };
  readonly listByWorkspaceStatement: {
    all(...args: readonly unknown[]): unknown[];
  };
  readonly upsertStatement: {
    run(...args: readonly unknown[]): unknown;
  };
}

export class SqliteEngineBindingRepo implements EngineBindingRepo {
  private readonly statementHolder: RefreshableStatementHolder<EngineBindingStatements>;

  public constructor(db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, (database) => ({
      getByIdStatement: database.connection.prepare(`
        SELECT
          binding_id,
          workspace_id,
          provider_type,
          base_url,
          api_key,
          api_key_ref,
          model,
          config_json,
          enable_tools,
          created_at,
          updated_at
        FROM engine_bindings
        WHERE binding_id = ?
        LIMIT 1
      `),
      listByWorkspaceStatement: database.connection.prepare(`
        SELECT
          binding_id,
          workspace_id,
          provider_type,
          base_url,
          api_key,
          api_key_ref,
          model,
          config_json,
          enable_tools,
          created_at,
          updated_at
        FROM engine_bindings
        WHERE workspace_id = ?
        ORDER BY created_at ASC, binding_id ASC
      `),
      upsertStatement: database.connection.prepare(`
        INSERT INTO engine_bindings (
          binding_id,
          workspace_id,
          provider_type,
          base_url,
          api_key,
          api_key_ref,
          model,
          config_json,
          enable_tools,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          provider_type = excluded.provider_type,
          base_url = excluded.base_url,
          api_key = excluded.api_key,
          api_key_ref = excluded.api_key_ref,
          model = excluded.model,
          config_json = excluded.config_json,
          enable_tools = excluded.enable_tools,
          updated_at = excluded.updated_at
      `)
    }));
  }

  public upsert(data: EngineBindingRecordCreateInput): EngineBindingRecord {
    const existingRow = this.statementHolder.active().getByIdStatement.get(data.binding_id) as EngineBindingRow | undefined;
    const existing = existingRow === undefined ? null : parseEngineBindingRecord(existingRow);
    const now = new Date().toISOString();
    const record = parseEngineBindingRecord({
      ...data,
      created_at: existing?.created_at ?? now,
      updated_at: now
    });

    try {
      this.statementHolder.active().upsertStatement.run(
        record.binding_id,
        record.workspace_id,
        record.provider_type,
        record.base_url,
        encryptApiKeyAtRest(record.api_key),
        record.api_key_ref ?? null,
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
      const row = this.statementHolder.active().getByIdStatement.get(id) as EngineBindingRow | undefined;
      return row === undefined ? null : parseEngineBindingRecord(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load engine binding ${id}.`, error);
    }
  }

  public async listByWorkspace(workspaceId: string): Promise<readonly EngineBindingRecord[]> {
    try {
      const rows = this.statementHolder.active().listByWorkspaceStatement.all(workspaceId) as EngineBindingRow[];
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

  let decryptedApiKey: string;
  try {
    decryptedApiKey = decryptApiKeyAtRest(row.api_key);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to decrypt engine binding api_key: ciphertext is machine- and user-bound; host or OS-user drift, or a copied database from another machine, prevents decryption.",
      error
    );
  }

  let parsedConfig: Record<string, unknown>;
  try {
    parsedConfig = JSON.parse(rawConfig) as Record<string, unknown>;
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse engine binding config_json for binding ${row.binding_id}.`,
      error
    );
  }

  try {
    return EngineBindingRecordSchema.parse({
      binding_id: row.binding_id,
      workspace_id: row.workspace_id,
      provider_type: row.provider_type,
      base_url: row.base_url,
      api_key: decryptedApiKey,
      api_key_ref: row.api_key_ref,
      model: row.model,
      config: parsedConfig,
      ...(enableTools !== undefined ? { enable_tools: enableTools } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate engine binding row.", error);
  }
}
