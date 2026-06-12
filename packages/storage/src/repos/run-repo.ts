import { RunSchema, RunStateSchema, type Run, type RunState } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { cascadeDeleteRun } from "./cascade-delete.js";

export type RunCreateInput = Omit<Run, "created_at" | "last_active_at">;

export interface RunRepo {
  create(data: RunCreateInput): Run;
  getById(id: string): Promise<Run | null>;
  listByWorkspace(workspaceId: string): Promise<readonly Run[]>;
  delete(id: string): void;
  updateState(id: string, state: RunState): Promise<Run>;
  update(id: string, patch: Partial<Run>): Run;
}

interface RunRow {
  readonly run_id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly goal: string | null;
  readonly run_mode: string;
  readonly engine_binding_id: string | null;
  readonly engine_class: string | null;
  readonly run_state: string;
  readonly current_surface_id: string | null;
  readonly created_at: string;
  readonly last_active_at: string;
}

export class SqliteRunRepo implements RunRepo {
  private readonly createStatement;
  private readonly getByIdStatement;
  private readonly listByWorkspaceStatement;
  private readonly deleteStatement;
  private readonly updateStateStatement;
  private readonly updateTitleStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO runs (
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        engine_class,
        run_state,
        current_surface_id,
        created_at,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getByIdStatement = db.connection.prepare(`
      SELECT
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        engine_class,
        run_state,
        current_surface_id,
        created_at,
        last_active_at
      FROM runs
      WHERE run_id = ?
      LIMIT 1
    `);
    this.listByWorkspaceStatement = db.connection.prepare(`
      SELECT
        run_id,
        workspace_id,
        title,
        goal,
        run_mode,
        engine_binding_id,
        engine_class,
        run_state,
        current_surface_id,
        created_at,
        last_active_at
      FROM runs
      WHERE workspace_id = ?
      ORDER BY created_at ASC, run_id ASC
    `);
    this.deleteStatement = db.connection.prepare("DELETE FROM runs WHERE run_id = ?");
    this.updateStateStatement = db.connection.prepare(`
      UPDATE runs
      SET run_state = ?, last_active_at = ?
      WHERE run_id = ?
    `);
    this.updateTitleStatement = db.connection.prepare(`
      UPDATE runs
      SET title = ?
      WHERE run_id = ?
    `);
  }

  public create(data: RunCreateInput): Run {
    const now = new Date().toISOString();
    const run = parseRun({
      ...data,
      created_at: now,
      last_active_at: now
    });

    try {
      this.createStatement.run(
        run.run_id,
        run.workspace_id,
        run.title,
        run.goal,
        run.run_mode,
        run.engine_binding_id,
        run.engine_class,
        run.run_state,
        run.current_surface_id,
        run.created_at,
        run.last_active_at
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to create run.", error);
    }

    return run;
  }

  public async getById(id: string): Promise<Run | null> {
    try {
      const row = this.getByIdStatement.get(id) as RunRow | undefined;
      return row === undefined ? null : parseRun(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load run ${id}.`, error);
    }
  }

  public async listByWorkspace(workspaceId: string): Promise<readonly Run[]> {
    try {
      const rows = this.listByWorkspaceStatement.all(workspaceId) as RunRow[];
      return rows.map((row) => parseRun(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list runs for workspace ${workspaceId}.`, error);
    }
  }

  public delete(id: string): void {
    cascadeDeleteRun(this.db.connection, id);
  }

  public async updateState(id: string, state: RunState): Promise<Run> {
    const nextState = parseRunState(state);
    const updatedAt = new Date().toISOString();

    try {
      const result = this.updateStateStatement.run(nextState, updatedAt, id);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Run ${id} was not found.`);
      }

      const run = await this.getById(id);

      if (run === null) {
        throw new StorageError("NOT_FOUND", `Run ${id} was not found after update.`);
      }

      return run;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update state for run ${id}.`, error);
    }
  }

  public update(id: string, patch: Partial<Run>): Run {
    try {
      if (patch.title !== undefined) {
        const result = this.updateTitleStatement.run(patch.title, id);

        if (result.changes === 0) {
          throw new StorageError("NOT_FOUND", `Run ${id} was not found.`);
        }
      }

      const row = this.getByIdStatement.get(id) as RunRow | undefined;

      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Run ${id} was not found after update.`);
      }

      return parseRun(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update run ${id}.`, error);
    }
  }
}

function parseRun(row: RunRow): Run {
  try {
    return RunSchema.parse(row);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate run row.", error);
  }
}

function parseRunState(state: RunState): RunState {
  try {
    return RunStateSchema.parse(state);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate run state.", error);
  }
}
