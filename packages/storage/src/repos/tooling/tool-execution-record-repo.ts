import { ToolExecutionRecordSchema, type ToolExecutionRecord } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface ToolExecutionRecordRepo {
  insert(record: ToolExecutionRecord): Promise<Readonly<ToolExecutionRecord>>;
  findById(executionId: string): Promise<Readonly<ToolExecutionRecord> | null>;
  listByRunId(
    runId: string,
    requestedBy: "principal" | "worker"
  ): Promise<readonly Readonly<ToolExecutionRecord>[]>;
}

const TOOL_EXECUTION_RECORD_SELECT_COLUMNS = `
        execution_id,
        tool_id,
        requested_by,
        requesting_principal_run_id,
        requesting_worker_run_id,
        node_id,
        governance_decision_ref,
        permission_result,
        executed,
        started_at,
        ended_at,
        result_summary,
        rollback_status,
        post_effect_refs_json,
        affected_paths_json
`;

interface ToolExecutionRecordRow {
  readonly execution_id: string;
  readonly tool_id: string;
  readonly requested_by: "principal" | "worker";
  readonly requesting_principal_run_id: string | null;
  readonly requesting_worker_run_id: string | null;
  readonly node_id: string | null;
  readonly governance_decision_ref: string;
  readonly permission_result: "allow" | "ask" | "deny";
  readonly executed: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly result_summary: string | null;
  readonly rollback_status: "none" | "attempted" | "succeeded" | "failed";
  readonly post_effect_refs_json: string;
  readonly affected_paths_json: string | null;
}

export class SqliteToolExecutionRecordRepo implements ToolExecutionRecordRepo {
  private readonly insertStatement;
  private readonly findByIdStatement;
  private readonly listByPrincipalRunIdStatement;
  private readonly listByWorkerRunIdStatement;

  public constructor(db: StorageDatabase) {
    this.insertStatement = db.connection.prepare(`
      INSERT INTO tool_execution_records (
        execution_id,
        tool_id,
        requested_by,
        requesting_principal_run_id,
        requesting_worker_run_id,
        node_id,
        governance_decision_ref,
        permission_result,
        executed,
        started_at,
        ended_at,
        result_summary,
        rollback_status,
        post_effect_refs_json,
        affected_paths_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${TOOL_EXECUTION_RECORD_SELECT_COLUMNS}
      FROM tool_execution_records
      WHERE execution_id = ?
      LIMIT 1
    `);

    this.listByPrincipalRunIdStatement = db.connection.prepare(`
      SELECT${TOOL_EXECUTION_RECORD_SELECT_COLUMNS}
      FROM tool_execution_records
      WHERE requested_by = 'principal' AND requesting_principal_run_id = ?
      ORDER BY execution_id ASC
    `);

    this.listByWorkerRunIdStatement = db.connection.prepare(`
      SELECT${TOOL_EXECUTION_RECORD_SELECT_COLUMNS}
      FROM tool_execution_records
      WHERE requested_by = 'worker' AND requesting_worker_run_id = ?
      ORDER BY execution_id ASC
    `);
  }

  public async insert(record: ToolExecutionRecord): Promise<Readonly<ToolExecutionRecord>> {
    const parsedRecord = parseToolExecutionRecord(record);
    const requestingPrincipalRunId =
      parsedRecord.requested_by === "principal" ? parsedRecord.requesting_run_id : null;
    const requestingWorkerRunId =
      parsedRecord.requested_by === "worker" ? parsedRecord.requesting_run_id : null;

    try {
      this.insertStatement.run(
        parsedRecord.execution_id,
        parsedRecord.tool_id,
        parsedRecord.requested_by,
        requestingPrincipalRunId,
        requestingWorkerRunId,
        parsedRecord.node_id ?? null,
        parsedRecord.governance_decision_ref,
        parsedRecord.permission_result,
        toSqliteBoolean(parsedRecord.executed),
        parsedRecord.started_at ?? null,
        parsedRecord.ended_at ?? null,
        parsedRecord.result_summary ?? null,
        parsedRecord.rollback_status,
        JSON.stringify(parsedRecord.post_effect_refs ?? []),
        serializeAffectedPaths(parsedRecord.affected_paths)
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert tool execution record ${parsedRecord.execution_id}.`,
        error
      );
    }

    const inserted = await this.findById(parsedRecord.execution_id);

    if (inserted === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Tool execution record ${parsedRecord.execution_id} was not found after insert.`
      );
    }

    return inserted;
  }

  public async findById(executionId: string): Promise<Readonly<ToolExecutionRecord> | null> {
    try {
      const row = this.findByIdStatement.get(executionId) as ToolExecutionRecordRow | undefined;
      return row === undefined ? null : parseToolExecutionRecordRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load tool execution record ${executionId}.`,
        error
      );
    }
  }

  public async listByRunId(
    runId: string,
    requestedBy: "principal" | "worker"
  ): Promise<readonly Readonly<ToolExecutionRecord>[]> {
    try {
      const statement =
        requestedBy === "principal"
          ? this.listByPrincipalRunIdStatement
          : this.listByWorkerRunIdStatement;
      const rows = statement.all(runId) as ToolExecutionRecordRow[];
      return rows.map((row) => parseToolExecutionRecordRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list tool execution records for ${requestedBy} run ${runId}.`,
        error
      );
    }
  }
}

function parseToolExecutionRecord(value: ToolExecutionRecord): Readonly<ToolExecutionRecord> {
  try {
    return deepFreeze(ToolExecutionRecordSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate tool execution record.", error);
  }
}

function parseToolExecutionRecordRow(row: ToolExecutionRecordRow): Readonly<ToolExecutionRecord> {
  const requestingRunId = row.requesting_principal_run_id ?? row.requesting_worker_run_id;

  if (requestingRunId === null) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to validate tool execution record row: requesting run id is missing."
    );
  }

  let postEffectRefs: readonly string[];

  try {
    postEffectRefs = JSON.parse(row.post_effect_refs_json) as readonly string[];
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to parse tool execution record post_effect_refs_json.",
      error
    );
  }

  let affectedPaths: readonly string[] | null | undefined;

  if (row.affected_paths_json === null) {
    affectedPaths = undefined;
  } else {
    try {
      affectedPaths = JSON.parse(row.affected_paths_json) as readonly string[] | null;
    } catch (error) {
      throw new StorageError(
        "VALIDATION_FAILED",
        "Failed to parse tool execution record affected_paths_json.",
        error
      );
    }
  }

  try {
    return deepFreeze(
      ToolExecutionRecordSchema.parse({
        execution_id: row.execution_id,
        tool_id: row.tool_id,
        requested_by: row.requested_by,
        requesting_run_id: requestingRunId,
        node_id: row.node_id ?? undefined,
        governance_decision_ref: row.governance_decision_ref,
        permission_result: row.permission_result,
        executed: row.executed !== 0,
        started_at: row.started_at ?? undefined,
        ended_at: row.ended_at ?? undefined,
        result_summary: row.result_summary ?? undefined,
        rollback_status: row.rollback_status,
        post_effect_refs: postEffectRefs,
        ...(affectedPaths === undefined ? {} : { affected_paths: affectedPaths })
      })
    );
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Failed to validate tool execution record row.",
      error
    );
  }
}

function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function serializeAffectedPaths(value: readonly string[] | null | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
