import type { WorkspaceEngineConfigRepoPort } from "@do-soul/alaya-core";
import {
  EngineBindingRecordSchema,
  WorkspaceSchema,
  type EngineBindingInput,
  type EngineBindingRecord,
  type Workspace
} from "@do-soul/alaya-protocol";
import { StorageError, type StorageDatabase } from "@do-soul/alaya-storage";

// Minimal structural type matching the surface of better-sqlite3's
// `Statement` that this repo actually exercises (`run` and `get`). Using a
// structural shape avoids taking a direct dependency on `better-sqlite3`
// from `apps/core-daemon` while still capturing the runtime contract that
// `StorageDatabase#connection.prepare(...)` returns. This replaces the
// previous `any` fields, restoring real type-checking on prepared statement
// usage in `ensureStatements()`.
interface PreparedStatement {
  run(...params: readonly unknown[]): { readonly changes: number; readonly lastInsertRowid: number | bigint };
  get(...params: readonly unknown[]): unknown;
}

interface WorkspaceEngineStatements {
  readonly upsertBinding: PreparedStatement;
  readonly updateWorkspace: PreparedStatement;
  readonly getWorkspaceById: PreparedStatement;
  readonly getBindingById: PreparedStatement;
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly name: string;
  readonly root_path: string;
  readonly workspace_kind: string;
  readonly repo_path: string | null;
  readonly default_engine_binding: string | null;
  readonly default_engine_class: "coding_engine" | "conversation_engine" | null;
  readonly workspace_state: string;
  readonly created_at: string;
  readonly archived_at: string | null;
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

export interface SqliteWorkspaceEngineConfigRepoOptions {
  readonly onAfterBindingUpsert?: () => void;
  readonly now?: () => string;
}

export class SqliteWorkspaceEngineConfigRepo implements WorkspaceEngineConfigRepoPort {
  private statements: WorkspaceEngineStatements | null = null;

  public constructor(
    private readonly db: StorageDatabase,
    private readonly options: SqliteWorkspaceEngineConfigRepoOptions = {}
  ) {}

  public upsertConversationBindingAndSetDefaultEngineClass(input: {
    readonly workspace_id: string;
    readonly binding_id: string;
    readonly binding: EngineBindingInput;
  }): {
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  } {
    const now = this.options.now?.() ?? new Date().toISOString();
    const statements = this.ensureStatements();

    try {
      this.persistBindingRecord(statements, input, now);
      this.updateWorkspaceDefaultBinding(statements, input.workspace_id, input.binding_id);
      const workspace = this.readWorkspaceRecord(statements, input.workspace_id);
      const binding = this.readBindingRecord(statements, input.binding_id);
      this.assertBindingBelongsToWorkspace(workspace, binding);
      return { workspace, binding };
    } catch (error) {
      throw this.wrapUpsertError(input.workspace_id, error);
    }
  }

  private persistBindingRecord(
    statements: WorkspaceEngineStatements,
    input: {
      readonly workspace_id: string;
      readonly binding_id: string;
      readonly binding: EngineBindingInput;
    },
    now: string
  ): void {
    statements.upsertBinding.run(
      input.binding_id,
      input.workspace_id,
      input.binding.provider_type,
      input.binding.base_url,
      input.binding.api_key ?? "",
      input.binding.api_key_ref ?? null,
      input.binding.model,
      JSON.stringify(input.binding.config),
      input.binding.enable_tools !== undefined ? (input.binding.enable_tools ? 1 : 0) : null,
      now,
      now
    );
    this.options.onAfterBindingUpsert?.();
  }

  private updateWorkspaceDefaultBinding(
    statements: WorkspaceEngineStatements,
    workspaceId: string,
    bindingId: string
  ): void {
    const workspaceUpdate = statements.updateWorkspace.run(bindingId, workspaceId);
    if (workspaceUpdate.changes === 0) {
      throw new StorageError("NOT_FOUND", `Workspace ${workspaceId} was not found.`);
    }
  }

  private readWorkspaceRecord(statements: WorkspaceEngineStatements, workspaceId: string): Workspace {
    const workspaceRow = statements.getWorkspaceById.get(workspaceId) as WorkspaceRow | undefined;
    if (workspaceRow === undefined) {
      throw new StorageError("NOT_FOUND", `Workspace ${workspaceId} was not found after update.`);
    }
    return parseWorkspace(workspaceRow);
  }

  private readBindingRecord(statements: WorkspaceEngineStatements, bindingId: string): EngineBindingRecord {
    const bindingRow = statements.getBindingById.get(bindingId) as EngineBindingRow | undefined;
    if (bindingRow === undefined) {
      throw new StorageError("NOT_FOUND", `Engine binding ${bindingId} was not found after upsert.`);
    }
    return parseEngineBinding(bindingRow);
  }

  private assertBindingBelongsToWorkspace(workspace: Workspace, binding: EngineBindingRecord): void {
    if (binding.workspace_id !== workspace.workspace_id) {
      throw new StorageError(
        "QUERY_FAILED",
        `Engine binding ${binding.binding_id} does not belong to workspace ${workspace.workspace_id}.`
      );
    }
  }

  private wrapUpsertError(workspaceId: string, error: unknown): StorageError {
    if (error instanceof StorageError) {
      return error;
    }
    return new StorageError(
      "QUERY_FAILED",
      `Failed to atomically persist conversation engine config for workspace ${workspaceId}.`,
      error
    );
  }

  private ensureStatements(): WorkspaceEngineStatements {
    if (this.statements !== null) {
      return this.statements;
    }
    this.assertPrepareAvailable();
    this.statements = createWorkspaceEngineStatements(this.db);
    return this.statements;
  }

  private assertPrepareAvailable(): void {
    if (typeof this.db.connection.prepare !== "function") {
      throw new StorageError(
        "QUERY_FAILED",
        "SQLite connection does not provide prepare(); conversation engine-config persistence is unavailable."
      );
    }
  }

}

function createWorkspaceEngineStatements(db: StorageDatabase): WorkspaceEngineStatements {
  return {
    upsertBinding: prepareUpsertBindingStatement(db),
    updateWorkspace: prepareUpdateWorkspaceStatement(db),
    getWorkspaceById: prepareGetWorkspaceByIdStatement(db),
    getBindingById: prepareGetBindingByIdStatement(db)
  };
}

function prepareUpsertBindingStatement(db: StorageDatabase): PreparedStatement {
  return db.connection.prepare(`
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
  `);
}

function prepareUpdateWorkspaceStatement(db: StorageDatabase): PreparedStatement {
  return db.connection.prepare(`
    UPDATE workspaces
    SET default_engine_binding = ?, default_engine_class = 'conversation_engine'
    WHERE workspace_id = ?
  `);
}

function prepareGetWorkspaceByIdStatement(db: StorageDatabase): PreparedStatement {
  return db.connection.prepare(`
    SELECT
      workspace_id,
      name,
      root_path,
      workspace_kind,
      repo_path,
      default_engine_binding,
      default_engine_class,
      workspace_state,
      created_at,
      archived_at
    FROM workspaces
    WHERE workspace_id = ?
    LIMIT 1
  `);
}

function prepareGetBindingByIdStatement(db: StorageDatabase): PreparedStatement {
  return db.connection.prepare(`
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
  `);
}

function parseWorkspace(row: WorkspaceRow): Workspace {
  try {
    return WorkspaceSchema.parse(row);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate workspace row.", error);
  }
}

function parseEngineBinding(row: EngineBindingRow): EngineBindingRecord {
  try {
    return EngineBindingRecordSchema.parse({
      binding_id: row.binding_id,
      workspace_id: row.workspace_id,
      provider_type: row.provider_type,
      base_url: row.base_url,
      api_key: row.api_key,
      api_key_ref: row.api_key_ref,
      model: row.model,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      ...(row.enable_tools !== null ? { enable_tools: row.enable_tools === 1 } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate engine binding row.", error);
  }
}
