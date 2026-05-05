import { DirtyStateDossierSchema, type DirtyStateDossier } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

interface DirtyStateDossierRow {
  readonly dossier_id: string;
  readonly worker_run_id: string;
  readonly principal_run_id: string;
  readonly workspace_id: string;
  readonly trigger: string;
  readonly panic_source: string;
  readonly panic_summary: string;
  readonly affected_data_scope: string;
  readonly created_at: string;
}

export interface DirtyStateDossierRepo {
  create(dossier: DirtyStateDossier): Readonly<DirtyStateDossier>;
  deleteById(dossierId: string): Promise<void>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<DirtyStateDossier>[]>;
  findByWorkerRun(workerRunId: string): Promise<readonly Readonly<DirtyStateDossier>[]>;
}

const DOSSIER_SELECT_COLUMNS = `
        dossier_id,
        worker_run_id,
        principal_run_id,
        workspace_id,
        trigger,
        panic_source,
        panic_summary,
        affected_data_scope,
        created_at
`;

export class SqliteDirtyStateDossierRepo implements DirtyStateDossierRepo {
  private readonly insertStatement;
  private readonly deleteByIdStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly findByWorkerRunStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.insertStatement = db.connection.prepare(`
      INSERT INTO dirty_state_dossiers (
        dossier_id,
        worker_run_id,
        principal_run_id,
        workspace_id,
        trigger,
        panic_source,
        panic_summary,
        affected_data_scope,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${DOSSIER_SELECT_COLUMNS}
      FROM dirty_state_dossiers
      WHERE dossier_id = ?
      LIMIT 1
    `);
    this.deleteByIdStatement = db.connection.prepare(`
      DELETE FROM dirty_state_dossiers
      WHERE dossier_id = ?
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${DOSSIER_SELECT_COLUMNS}
      FROM dirty_state_dossiers
      WHERE workspace_id = ?
      ORDER BY created_at ASC, dossier_id ASC
    `);

    this.findByWorkerRunStatement = db.connection.prepare(`
      SELECT${DOSSIER_SELECT_COLUMNS}
      FROM dirty_state_dossiers
      WHERE worker_run_id = ?
      ORDER BY created_at ASC, dossier_id ASC
    `);
  }

  public create(dossier: DirtyStateDossier): Readonly<DirtyStateDossier> {
    const parsed = parseDirtyStateDossier(dossier);

    try {
      this.insertStatement.run(
        parsed.dossier_id,
        parsed.worker_run_id,
        parsed.principal_run_id,
        parsed.workspace_id,
        parsed.trigger,
        parsed.panic_source,
        parsed.panic_summary,
        JSON.stringify(parsed.affected_data_scope),
        parsed.created_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert dirty state dossier ${parsed.dossier_id}.`,
        error
      );
    }

    try {
      const row = this.findByIdStatement.get(parsed.dossier_id) as
        | DirtyStateDossierRow
        | undefined;

      if (row === undefined) {
        throw new StorageError(
          "NOT_FOUND",
          `Dirty state dossier ${parsed.dossier_id} was not found after insert.`
        );
      }

      return parseDirtyStateDossierRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to reload dirty state dossier ${parsed.dossier_id} after insert.`,
        error
      );
    }
  }

  public async findByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<DirtyStateDossier>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as DirtyStateDossierRow[];
      return deepFreeze(rows.map((row) => parseDirtyStateDossierRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list dirty state dossiers for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async deleteById(dossierId: string): Promise<void> {
    const parsedDossierId = parseNonEmptyString(dossierId, "dossier id");

    try {
      this.deleteByIdStatement.run(parsedDossierId);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete dirty state dossier ${parsedDossierId}.`,
        error
      );
    }
  }

  public async findByWorkerRun(workerRunId: string): Promise<readonly Readonly<DirtyStateDossier>[]> {
    const parsedWorkerRunId = parseNonEmptyString(workerRunId, "worker run id");

    try {
      const rows = this.findByWorkerRunStatement.all(parsedWorkerRunId) as DirtyStateDossierRow[];
      return deepFreeze(rows.map((row) => parseDirtyStateDossierRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list dirty state dossiers for worker run ${parsedWorkerRunId}.`,
        error
      );
    }
  }
}

function parseDirtyStateDossier(value: DirtyStateDossier): Readonly<DirtyStateDossier> {
  try {
    return deepFreeze(DirtyStateDossierSchema.parse(value));
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to validate dirty state dossier.",
      error
    );
  }
}

function parseDirtyStateDossierRow(row: DirtyStateDossierRow): Readonly<DirtyStateDossier> {
  let affectedDataScope: unknown;

  try {
    affectedDataScope = JSON.parse(row.affected_data_scope);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to parse dirty state dossier affected_data_scope.",
      error
    );
  }

  return parseDirtyStateDossier({
    dossier_id: row.dossier_id,
    worker_run_id: row.worker_run_id,
    principal_run_id: row.principal_run_id,
    workspace_id: row.workspace_id,
    trigger: row.trigger as DirtyStateDossier["trigger"],
    panic_source: row.panic_source,
    panic_summary: row.panic_summary,
    affected_data_scope: affectedDataScope as DirtyStateDossier["affected_data_scope"],
    created_at: row.created_at
  });
}
