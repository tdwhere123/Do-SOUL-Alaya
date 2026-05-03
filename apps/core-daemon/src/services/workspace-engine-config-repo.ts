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
  private upsertBindingStatement: PreparedStatement | null = null;
  private updateWorkspaceStatement: PreparedStatement | null = null;
  private getWorkspaceByIdStatement: PreparedStatement | null = null;
  private getBindingByIdStatement: PreparedStatement | null = null;

  public constructor(
    private readonly db: StorageDatabase,
    private readonly options: SqliteWorkspaceEngineConfigRepoOptions = {}
  ) {}

  public async upsertConversationBindingAndSetDefaultEngineClass(input: {
    readonly workspace_id: string;
    readonly binding_id: string;
    readonly binding: EngineBindingInput;
  }): Promise<{
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  }> {
    const now = this.options.now?.() ?? new Date().toISOString();
    const statements = this.ensureStatements();

    try {
      return this.db.connection.transaction(() => {
        statements.upsertBinding.run(
          input.binding_id,
          input.workspace_id,
          input.binding.provider_type,
          input.binding.base_url,
          input.binding.api_key,
          input.binding.model,
          JSON.stringify(input.binding.config),
          input.binding.enable_tools !== undefined ? (input.binding.enable_tools ? 1 : 0) : null,
          now,
          now
        );
        this.options.onAfterBindingUpsert?.();

        const workspaceUpdate = statements.updateWorkspace.run(input.binding_id, input.workspace_id);
        if (workspaceUpdate.changes === 0) {
          throw new StorageError("NOT_FOUND", `Workspace ${input.workspace_id} was not found.`);
        }

        const workspaceRow = statements.getWorkspaceById.get(input.workspace_id) as WorkspaceRow | undefined;
        if (workspaceRow === undefined) {
          throw new StorageError("NOT_FOUND", `Workspace ${input.workspace_id} was not found after update.`);
        }

        const bindingRow = statements.getBindingById.get(input.binding_id) as EngineBindingRow | undefined;
        if (bindingRow === undefined) {
          throw new StorageError("NOT_FOUND", `Engine binding ${input.binding_id} was not found after upsert.`);
        }

        const workspace = parseWorkspace(workspaceRow);
        const binding = parseEngineBinding(bindingRow);

        if (binding.workspace_id !== workspace.workspace_id) {
          throw new StorageError(
            "QUERY_FAILED",
            `Engine binding ${binding.binding_id} does not belong to workspace ${workspace.workspace_id}.`
          );
        }

        return {
          workspace,
          binding
        };
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to atomically persist conversation engine config for workspace ${input.workspace_id}.`,
        error
      );
    }
  }

  private ensureStatements(): {
    readonly upsertBinding: PreparedStatement;
    readonly updateWorkspace: PreparedStatement;
    readonly getWorkspaceById: PreparedStatement;
    readonly getBindingById: PreparedStatement;
  } {
    if (
      this.upsertBindingStatement !== null &&
      this.updateWorkspaceStatement !== null &&
      this.getWorkspaceByIdStatement !== null &&
      this.getBindingByIdStatement !== null
    ) {
      return {
        upsertBinding: this.upsertBindingStatement,
        updateWorkspace: this.updateWorkspaceStatement,
        getWorkspaceById: this.getWorkspaceByIdStatement,
        getBindingById: this.getBindingByIdStatement
      };
    }

    if (typeof this.db.connection.prepare !== "function") {
      throw new StorageError(
        "QUERY_FAILED",
        "SQLite connection does not provide prepare(); conversation engine-config persistence is unavailable."
      );
    }

    this.upsertBindingStatement = this.db.connection.prepare(`
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
    `);
    this.updateWorkspaceStatement = this.db.connection.prepare(`
      UPDATE workspaces
      SET default_engine_binding = ?, default_engine_class = 'conversation_engine'
      WHERE workspace_id = ?
    `);
    this.getWorkspaceByIdStatement = this.db.connection.prepare(`
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
    this.getBindingByIdStatement = this.db.connection.prepare(`
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

    return {
      upsertBinding: this.upsertBindingStatement,
      updateWorkspace: this.updateWorkspaceStatement,
      getWorkspaceById: this.getWorkspaceByIdStatement,
      getBindingById: this.getBindingByIdStatement
    };
  }
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
