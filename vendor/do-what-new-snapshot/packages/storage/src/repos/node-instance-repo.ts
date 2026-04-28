import {
  IsoDatetimeStringSchema,
  NodeInstanceSchema,
  NodeInstanceStateSchema,
  type NodeInstance,
  type NodeInstanceState
} from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface NodeInstanceRepo {
  insert(instance: NodeInstance): Promise<Readonly<NodeInstance>>;
  getById(nodeId: string): Promise<Readonly<NodeInstance> | null>;
  updateState(
    nodeId: string,
    expectedState: NodeInstanceState,
    nextState: NodeInstanceState,
    updatedAt: string
  ): Promise<Readonly<NodeInstance>>;
  findByPrincipalRunId(principalRunId: string): Promise<readonly Readonly<NodeInstance>[]>;
}

const NODE_INSTANCE_SELECT_COLUMNS = `
        node_id,
        principal_run_id,
        node_template,
        state,
        task_surface_ref,
        stance_resolution_ref,
        created_at,
        updated_at
`;

interface NodeInstanceRow {
  readonly node_id: string;
  readonly principal_run_id: string;
  readonly node_template: string;
  readonly state: string;
  readonly task_surface_ref: string;
  readonly stance_resolution_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}


export class SqliteNodeInstanceRepo implements NodeInstanceRepo {
  private readonly insertStatement;
  private readonly getByIdStatement;
  private readonly updateStateStatement;
  private readonly findByPrincipalRunIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.insertStatement = db.connection.prepare(`
      INSERT INTO node_instances (
        node_id,
        principal_run_id,
        node_template,
        state,
        task_surface_ref,
        stance_resolution_ref,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getByIdStatement = db.connection.prepare(`
      SELECT${NODE_INSTANCE_SELECT_COLUMNS}
      FROM node_instances
      WHERE node_id = ?
      LIMIT 1
    `);

    this.updateStateStatement = db.connection.prepare(`
      UPDATE node_instances
      SET state = ?, updated_at = ?
      WHERE node_id = ? AND state = ?
    `);

    this.findByPrincipalRunIdStatement = db.connection.prepare(`
      SELECT${NODE_INSTANCE_SELECT_COLUMNS}
      FROM node_instances
      WHERE principal_run_id = ?
      ORDER BY created_at ASC
    `);
  }

  public async insert(instance: NodeInstance): Promise<Readonly<NodeInstance>> {
    const parsedInstance = parseNodeInstance(instance);

    try {
      this.insertStatement.run(
        parsedInstance.node_id,
        parsedInstance.principal_run_id,
        parsedInstance.node_template,
        parsedInstance.state,
        parsedInstance.task_surface_ref,
        parsedInstance.stance_resolution_ref,
        parsedInstance.created_at,
        parsedInstance.updated_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to insert node instance ${parsedInstance.node_id}.`,
        error
      );
    }

    const inserted = await this.getById(parsedInstance.node_id);

    if (inserted === null) {
      throw new StorageError(
        "NOT_FOUND",
        `Node instance ${parsedInstance.node_id} was not found after insert.`
      );
    }

    return inserted;
  }

  public async getById(nodeId: string): Promise<Readonly<NodeInstance> | null> {
    const parsedNodeId = parseNonEmptyString(nodeId, "node id");

    try {
      const row = this.getByIdStatement.get(parsedNodeId) as NodeInstanceRow | undefined;
      return row === undefined ? null : parseNodeInstanceRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to load node instance ${parsedNodeId}.`, error);
    }
  }

  public async updateState(
    nodeId: string,
    expectedState: NodeInstanceState,
    nextState: NodeInstanceState,
    updatedAt: string
  ): Promise<Readonly<NodeInstance>> {
    const parsedNodeId = parseNonEmptyString(nodeId, "node id");
    const parsedExpectedState = NodeInstanceStateSchema.parse(expectedState);
    const parsedNextState = NodeInstanceStateSchema.parse(nextState);
    const parsedUpdatedAt = parseNodeInstanceUpdatedAt(updatedAt);

    let changes = 0;

    try {
      changes = this.updateStateStatement.run(
        parsedNextState,
        parsedUpdatedAt,
        parsedNodeId,
        parsedExpectedState
      ).changes;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to update node instance ${parsedNodeId}.`, error);
    }

    if (changes === 0) {
      throw new StorageError("CONFLICT", `CAS failed for node instance ${parsedNodeId}: state mismatch.`);
    }

    const updated = await this.getById(parsedNodeId);

    if (updated === null) {
      throw new StorageError("NOT_FOUND", `Node instance ${parsedNodeId} was not found after update.`);
    }

    return updated;
  }

  public async findByPrincipalRunId(principalRunId: string): Promise<readonly Readonly<NodeInstance>[]> {
    const parsedPrincipalRunId = parseNonEmptyString(principalRunId, "principal run id");

    try {
      const rows = this.findByPrincipalRunIdStatement.all(parsedPrincipalRunId) as NodeInstanceRow[];
      return rows.map((row) => parseNodeInstanceRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list node instances for principal run ${parsedPrincipalRunId}.`,
        error
      );
    }
  }
}

function parseNodeInstance(value: NodeInstance): Readonly<NodeInstance> {
  try {
    return deepFreeze(NodeInstanceSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate node instance.", error);
  }
}

function parseNodeInstanceRow(row: NodeInstanceRow): Readonly<NodeInstance> {
  try {
    return deepFreeze(
      NodeInstanceSchema.parse({
        node_id: row.node_id,
        principal_run_id: row.principal_run_id,
        node_template: row.node_template,
        state: row.state,
        task_surface_ref: row.task_surface_ref,
        stance_resolution_ref: row.stance_resolution_ref,
        created_at: row.created_at,
        updated_at: row.updated_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate node instance row.", error);
  }
}

function parseNodeInstanceUpdatedAt(value: string): string {
  try {
    return IsoDatetimeStringSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate node instance updated_at.", error);
  }
}
