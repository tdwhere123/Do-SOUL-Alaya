import { WorkspaceSchema, type Workspace } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { cascadeDeleteWorkspace } from "./cascade-delete.js";

export type WorkspaceCreateInput = Omit<Workspace, "created_at" | "archived_at" | "repo_path"> & {
  readonly repo_path?: Workspace["repo_path"];
};

export interface WorkspaceRepo {
  create(data: WorkspaceCreateInput): Workspace;
  getById(id: string): Promise<Workspace | null>;
  list(): Promise<readonly Workspace[]>;
  delete(id: string): void;
  updateRepoPath(id: string, repoPath: Workspace["repo_path"]): Promise<Workspace>;
  updateDefaultEngineBinding(id: string, bindingId: string | null): Workspace;
  updateDefaultEngineClass(id: string, engineClass: Workspace["default_engine_class"]): Workspace;
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly name: string;
  readonly root_path: string;
  readonly workspace_kind: string;
  readonly repo_path: string | null;
  readonly default_engine_binding: string | null;
  readonly default_engine_class?: "coding_engine" | "conversation_engine" | null;
  readonly workspace_state: string;
  readonly created_at: string;
  readonly archived_at: string | null;
}

export class SqliteWorkspaceRepo implements WorkspaceRepo {
  private readonly createStatement;
  private readonly getByIdStatement;
  private readonly listStatement;
  private readonly deleteStatement;
  private readonly updateRepoPathStatement;
  private readonly updateDefaultEngineBindingStatement;
  private readonly updateDefaultEngineClassStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO workspaces (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getByIdStatement = db.connection.prepare(`
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
    this.listStatement = db.connection.prepare(`
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
      ORDER BY created_at ASC, workspace_id ASC
    `);
    this.deleteStatement = db.connection.prepare("DELETE FROM workspaces WHERE workspace_id = ?");
    this.updateRepoPathStatement = db.connection.prepare(`
      UPDATE workspaces
      SET repo_path = ?
      WHERE workspace_id = ?
    `);
    this.updateDefaultEngineBindingStatement = db.connection.prepare(`
      UPDATE workspaces
      SET default_engine_binding = ?
      WHERE workspace_id = ?
    `);
    this.updateDefaultEngineClassStatement = db.connection.prepare(`
      UPDATE workspaces
      SET default_engine_class = ?
      WHERE workspace_id = ?
    `);
  }

  public create(data: WorkspaceCreateInput): Workspace {
    const workspace = parseWorkspace({
      ...data,
      repo_path: data.repo_path ?? null,
      default_engine_class: data.default_engine_class ?? null,
      created_at: new Date().toISOString(),
      archived_at: null
    });

    try {
      this.createStatement.run(
        workspace.workspace_id,
        workspace.name,
        workspace.root_path,
        workspace.workspace_kind,
        workspace.repo_path,
        workspace.default_engine_binding,
        workspace.default_engine_class ?? null,
        workspace.workspace_state,
        workspace.created_at,
        workspace.archived_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to create workspace.", error);
    }

    return workspace;
  }

  public async getById(id: string): Promise<Workspace | null> {
    try {
      const row = this.getByIdStatement.get(id) as WorkspaceRow | undefined;
      return row === undefined ? null : parseWorkspace(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load workspace ${id}.`, error);
    }
  }

  public async list(): Promise<readonly Workspace[]> {
    try {
      const rows = this.listStatement.all() as WorkspaceRow[];
      return rows.map((row) => parseWorkspace(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to list workspaces.", error);
    }
  }

  public delete(id: string): void {
    cascadeDeleteWorkspace(this.db.connection, id);
  }

  public async updateRepoPath(id: string, repoPath: Workspace["repo_path"]): Promise<Workspace> {
    try {
      const result = this.updateRepoPathStatement.run(repoPath, id);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found.`);
      }

      const workspace = await this.getById(id);

      if (workspace === null) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found after update.`);
      }

      return workspace;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update repo_path for workspace ${id}.`, error);
    }
  }

  public updateDefaultEngineBinding(id: string, bindingId: string | null): Workspace {
    try {
      const result = this.updateDefaultEngineBindingStatement.run(bindingId, id);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found.`);
      }

      const row = this.getByIdStatement.get(id) as WorkspaceRow | undefined;

      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found after update.`);
      }

      return parseWorkspace(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update default engine binding for workspace ${id}.`, error);
    }
  }

  public updateDefaultEngineClass(
    id: string,
    engineClass: Workspace["default_engine_class"]
  ): Workspace {
    try {
      const result = this.updateDefaultEngineClassStatement.run(engineClass ?? null, id);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found.`);
      }

      const row = this.getByIdStatement.get(id) as WorkspaceRow | undefined;

      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Workspace ${id} was not found after update.`);
      }

      return parseWorkspace(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update default engine class for workspace ${id}.`, error);
    }
  }
}

function parseWorkspace(row: WorkspaceRow): Workspace {
  try {
    return WorkspaceSchema.parse(row);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate workspace row.", error);
  }
}
