import {
  DelegatedWorkerRunSchema,
  IsoDatetimeStringSchema,
  WorkerRunStateSchema,
  type DelegatedWorkerRun,
  type WorkerRunState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";
import { prepareWorkerRunStatements, type SqliteStatement } from "./worker-run-statements.js";

export interface WorkerRunRepo {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  deleteIfState(workerRunId: string, expectedState: WorkerRunState): Promise<void>;
  updateState(
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): Readonly<DelegatedWorkerRun>;
  insert(run: DelegatedWorkerRun): Promise<Readonly<DelegatedWorkerRun>>;
  insertIfNoActiveForPrincipal(
    principalRunId: string,
    run: DelegatedWorkerRun
  ): Promise<Readonly<DelegatedWorkerRun>>;
  findActiveByPrincipalRunId(
    principalRunId: string
  ): Promise<Readonly<DelegatedWorkerRun> | null>;
}

interface WorkerRunRow {
  readonly worker_run_id: string;
  readonly principal_run_id: string;
  readonly workspace_id: string;
  readonly requesting_principal_run_id: string | null;
  readonly requesting_worker_run_id: string | null;
  readonly engine_class: string;
  readonly state: string;
  readonly subtask_description: string;
  readonly local_surface_ref: string;
  readonly local_evidence_pointer: string | null;
  readonly restricted_tool_set_json: string;
  readonly local_budget_json: string;
  readonly agreed_return_format_json: string;
  readonly principal_security_snapshot_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CountRow {
  readonly active_count: number;
}

interface InsertableWorkerRunRow {
  readonly workerRunId: string;
  readonly principalRunId: string;
  readonly workspaceId: string;
  readonly requestingPrincipalRunId: string | null;
  readonly requestingWorkerRunId: string | null;
  readonly engineClass: DelegatedWorkerRun["engine_class"];
  readonly state: WorkerRunState;
  readonly subtaskDescription: string;
  readonly localSurfaceRef: string;
  readonly localEvidencePointer: string | null;
  readonly restrictedToolSetJson: string;
  readonly localBudgetJson: string;
  readonly agreedReturnFormatJson: string;
  readonly principalSecuritySnapshotJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class SqliteWorkerRunRepo implements WorkerRunRepo {
  private readonly insertStatement: SqliteStatement;
  private readonly getByIdStatement: SqliteStatement;
  private readonly deleteIfStateStatement: SqliteStatement;
  private readonly updateStateStatement: SqliteStatement;
  private readonly findActiveByPrincipalRunIdStatement: SqliteStatement;
  private readonly countActiveByRequestingPrincipalStatement: SqliteStatement;
  private readonly insertIfNoActiveForPrincipalTransaction: {
    immediate(...params: readonly unknown[]): unknown;
  };

  public constructor(private readonly db: StorageDatabase) {
    const statements = prepareWorkerRunStatements(db);
    this.insertStatement = statements.insertStatement;
    this.getByIdStatement = statements.getByIdStatement;
    this.deleteIfStateStatement = statements.deleteIfStateStatement;
    this.updateStateStatement = statements.updateStateStatement;
    this.findActiveByPrincipalRunIdStatement = statements.findActiveByPrincipalRunIdStatement;
    this.countActiveByRequestingPrincipalStatement = statements.countActiveByRequestingPrincipalStatement;
    this.insertIfNoActiveForPrincipalTransaction = this.createInsertIfNoActiveForPrincipalTransaction();
  }

  private createInsertIfNoActiveForPrincipalTransaction(): {
    immediate(...params: readonly unknown[]): unknown;
  } {
    return this.db.connection.transaction((principalRunId: string, insertable: InsertableWorkerRunRow) => {
      this.assertNoActiveWorkerForPrincipal(principalRunId);
      this.insertWorkerRunRow(insertable);
      return this.getByIdStatement.get(insertable.workerRunId) as WorkerRunRow | undefined;
    });
  }

  private assertNoActiveWorkerForPrincipal(principalRunId: string): void {
    const activeCountRow = this.countActiveByRequestingPrincipalStatement.get(principalRunId) as CountRow | undefined;
    if ((activeCountRow?.active_count ?? 0) > 0) {
      throw new StorageError(
        "CONFLICT",
        `Serial delegation: principal ${principalRunId} already has an in-flight worker`
      );
    }
  }

  private insertWorkerRunRow(insertable: InsertableWorkerRunRow): void {
    this.insertStatement.run(
      insertable.workerRunId,
      insertable.principalRunId,
      insertable.workspaceId,
      insertable.requestingPrincipalRunId,
      insertable.requestingWorkerRunId,
      insertable.engineClass,
      insertable.state,
      insertable.subtaskDescription,
      insertable.localSurfaceRef,
      insertable.localEvidencePointer,
      insertable.restrictedToolSetJson,
      insertable.localBudgetJson,
      insertable.agreedReturnFormatJson,
      insertable.principalSecuritySnapshotJson,
      insertable.createdAt,
      insertable.updatedAt
    );
  }

  public async insert(run: DelegatedWorkerRun): Promise<Readonly<DelegatedWorkerRun>> {
    const insertable = this.toInsertableRow(run);

    try {
      this.insertWorkerRunRow(insertable);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert worker run ${insertable.workerRunId}.`,
        error
      );
    }

    const inserted = await this.getById(insertable.workerRunId);

    if (inserted === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Worker run ${insertable.workerRunId} was not found after insert.`
      );
    }

    return inserted;
  }

  public async insertIfNoActiveForPrincipal(
    principalRunId: string,
    run: DelegatedWorkerRun
  ): Promise<Readonly<DelegatedWorkerRun>> {
    const parsedPrincipalRunId = parseNonEmptyString(principalRunId, "principal run id");
    const insertable = this.toInsertableRow(run);

    try {
      const row = this.insertIfNoActiveForPrincipalTransaction.immediate(
        parsedPrincipalRunId,
        insertable
      ) as WorkerRunRow | undefined;

      if (row === undefined) {
        throw new StorageError(
          "NOT_FOUND",
          `Worker run ${insertable.workerRunId} was not found after insert.`
        );
      }

      return this.mapRowToDomain(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to atomically insert worker run ${insertable.workerRunId}.`,
        error
      );
    }
  }

  public async getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null> {
    const parsedWorkerRunId = parseNonEmptyString(workerRunId, "worker run id");

    try {
      const row = this.getByIdStatement.get(parsedWorkerRunId) as WorkerRunRow | undefined;
      return row === undefined ? null : this.mapRowToDomain(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load worker run ${parsedWorkerRunId}.`,
        error
      );
    }
  }

  public async deleteIfState(workerRunId: string, expectedState: WorkerRunState): Promise<void> {
    const parsedWorkerRunId = parseNonEmptyString(workerRunId, "worker run id");
    const parsedExpectedState = WorkerRunStateSchema.parse(expectedState);

    try {
      const result = this.deleteIfStateStatement.run(parsedWorkerRunId, parsedExpectedState);

      if (result.changes > 0) {
        return;
      }
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete worker run ${parsedWorkerRunId}.`,
        error
      );
    }

    const existing = await this.getById(parsedWorkerRunId);

    if (existing === null) {
      throw new StorageError("NOT_FOUND", `Worker run ${parsedWorkerRunId} was not found.`);
    }

    throw new StorageError(
      "CONFLICT",
      `CAS delete failed for worker run ${parsedWorkerRunId}: expected ${parsedExpectedState}, found ${existing.state}.`
    );
  }

  public updateState(
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): Readonly<DelegatedWorkerRun> {
    const parsedWorkerRunId = parseNonEmptyString(workerRunId, "worker run id");
    const parsedExpectedState = WorkerRunStateSchema.parse(expectedState);
    const parsedNextState = WorkerRunStateSchema.parse(nextState);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    let changes = 0;

    try {
      changes = this.updateStateStatement.run(
        parsedNextState,
        parsedUpdatedAt,
        parsedWorkerRunId,
        parsedExpectedState
      ).changes;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update worker run ${parsedWorkerRunId}.`,
        error
      );
    }

    if (changes === 0) {
      throw new StorageError(
        "CONFLICT",
        `CAS failed for worker run ${parsedWorkerRunId}: state mismatch or not found.`
      );
    }

    const row = this.getByIdStatement.get(parsedWorkerRunId) as WorkerRunRow | undefined;

    if (row === undefined) {
      throw new StorageError(
        "NOT_FOUND",
        `Worker run ${parsedWorkerRunId} was not found after update.`
      );
    }

    return this.mapRowToDomain(row);
  }

  public async findActiveByPrincipalRunId(
    principalRunId: string
  ): Promise<Readonly<DelegatedWorkerRun> | null> {
    const parsedPrincipalRunId = parseNonEmptyString(principalRunId, "principal run id");

    try {
      const row = this.findActiveByPrincipalRunIdStatement.get(
        parsedPrincipalRunId
      ) as WorkerRunRow | undefined;
      return row === undefined ? null : this.mapRowToDomain(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to find active worker run for principal ${parsedPrincipalRunId}.`,
        error
      );
    }
  }

  private toInsertableRow(run: DelegatedWorkerRun): InsertableWorkerRunRow {
    const parsedRun = parseWorkerRun(run);

    return {
      workerRunId: parsedRun.worker_run_id,
      principalRunId: parsedRun.principal_run_id,
      workspaceId: parsedRun.workspace_id,
      requestingPrincipalRunId: parsedRun.requesting_run_id,
      requestingWorkerRunId: null,
      engineClass: parsedRun.engine_class,
      state: parsedRun.state,
      subtaskDescription: parsedRun.subtask_description,
      localSurfaceRef: parsedRun.local_surface_ref,
      localEvidencePointer: parsedRun.local_evidence_pointer,
      restrictedToolSetJson: JSON.stringify(parsedRun.restricted_tool_set),
      localBudgetJson: JSON.stringify(parsedRun.local_budget),
      agreedReturnFormatJson: JSON.stringify(parsedRun.agreed_return_format),
      principalSecuritySnapshotJson: JSON.stringify(parsedRun.principal_security_snapshot),
      createdAt: parsedRun.created_at,
      updatedAt: parsedRun.updated_at
    };
  }

  private mapRowToDomain(row: WorkerRunRow): Readonly<DelegatedWorkerRun> {
    const requestingRunId = row.requesting_principal_run_id ?? row.requesting_worker_run_id;

    if (requestingRunId === null) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Failed to validate worker run row: requesting run id is missing."
      );
    }

    return parseWorkerRun({
      worker_run_id: row.worker_run_id,
      principal_run_id: row.principal_run_id,
      workspace_id: row.workspace_id,
      requesting_run_id: requestingRunId,
      engine_class: row.engine_class,
      state: row.state,
      subtask_description: row.subtask_description,
      local_surface_ref: row.local_surface_ref,
      local_evidence_pointer: row.local_evidence_pointer,
      restricted_tool_set: parseJsonField(row.restricted_tool_set_json, "restricted_tool_set_json"),
      local_budget: parseJsonField(row.local_budget_json, "local_budget_json"),
      agreed_return_format: parseJsonField(
        row.agreed_return_format_json,
        "agreed_return_format_json"
      ),
      principal_security_snapshot: parseJsonField(
        row.principal_security_snapshot_json,
        "principal_security_snapshot_json"
      ),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
}

function parseWorkerRun(value: unknown): Readonly<DelegatedWorkerRun> {
  try {
    return deepFreeze(DelegatedWorkerRunSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate worker run.", error);
  }
}

function parseJsonField(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Failed to parse ${field}.`, error);
  }
}

function parseUpdatedAt(value: string): string {
  try {
    return IsoDatetimeStringSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate worker run updated_at.", error);
  }
}
