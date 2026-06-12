import { GreenStatusSchema, type GreenStatus } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

export interface GreenStatusRepo {
  findByObjectId(objectId: string): Promise<Readonly<GreenStatus> | null>;
  findByTargetObjectId(targetObjectId: string): Promise<Readonly<GreenStatus> | null>;
  findEligible(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  findGrace(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  upsert(greenStatus: Readonly<GreenStatus>): Promise<Readonly<GreenStatus>>;
  delete(objectId: string): Promise<void>;
}

const GREEN_STATUS_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        target_object_id,
        target_object_kind,
        green_state,
        verification_basis,
        verified_by,
        verified_at,
        valid_until,
        bound_surfaces,
        bound_scope_class,
        revoke_reason,
        last_transition_at,
        workspace_id
`;

interface GreenStatusRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly green_state: string;
  readonly verification_basis: string;
  readonly verified_by: string;
  readonly verified_at: string | null;
  readonly valid_until: string | null;
  readonly bound_surfaces: string;
  readonly bound_scope_class: string | null;
  readonly revoke_reason: string;
  readonly last_transition_at: string;
  readonly workspace_id: string;
}

export class SqliteGreenStatusRepo implements GreenStatusRepo {
  private readonly findByObjectIdStatement;
  private readonly findByTargetObjectIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findEligibleStatement;
  private readonly findGraceStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.findByObjectIdStatement = db.connection.prepare(`
      SELECT${GREEN_STATUS_SELECT_COLUMNS}
      FROM green_statuses
      WHERE object_id = ?
      LIMIT 1
    `);
    this.findByTargetObjectIdStatement = db.connection.prepare(`
      SELECT${GREEN_STATUS_SELECT_COLUMNS}
      FROM green_statuses
      WHERE target_object_id = ?
      LIMIT 1
    `);
    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${GREEN_STATUS_SELECT_COLUMNS}
      FROM green_statuses
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findEligibleStatement = db.connection.prepare(`
      SELECT${GREEN_STATUS_SELECT_COLUMNS}
      FROM green_statuses
      WHERE workspace_id = ? AND green_state = 'eligible'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.findGraceStatement = db.connection.prepare(`
      SELECT${GREEN_STATUS_SELECT_COLUMNS}
      FROM green_statuses
      WHERE workspace_id = ? AND green_state = 'grace'
      ORDER BY created_at ASC, object_id ASC
    `);
    this.upsertStatement = db.connection.prepare(`
      INSERT OR REPLACE INTO green_statuses (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        target_object_id,
        target_object_kind,
        green_state,
        verification_basis,
        verified_by,
        verified_at,
        valid_until,
        bound_surfaces,
        bound_scope_class,
        revoke_reason,
        last_transition_at,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.deleteStatement = db.connection.prepare(`
      DELETE FROM green_statuses
      WHERE object_id = ?
    `);
  }

  public async findByObjectId(objectId: string): Promise<Readonly<GreenStatus> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "green status object id");

    try {
      const row = this.findByObjectIdStatement.get(parsedObjectId) as GreenStatusRow | undefined;
      return row === undefined ? null : parseGreenStatusRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load green status by object id ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findByTargetObjectId(targetObjectId: string): Promise<Readonly<GreenStatus> | null> {
    const parsedTargetObjectId = parseNonEmptyString(targetObjectId, "target object id");

    try {
      const row = this.findByTargetObjectIdStatement.get(parsedTargetObjectId) as GreenStatusRow | undefined;
      return row === undefined ? null : parseGreenStatusRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load green status for target object ${parsedTargetObjectId}.`,
        error
      );
    }
  }

  public async findEligible(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return this.findByState(this.findEligibleStatement, workspaceId, "eligible");
  }

  public async findGrace(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return this.findByState(this.findGraceStatement, workspaceId, "grace");
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as GreenStatusRow[];
      return rows.map((row) => parseGreenStatusRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list green statuses for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async upsert(greenStatus: Readonly<GreenStatus>): Promise<Readonly<GreenStatus>> {
    const parsedGreenStatus = parseGreenStatus(greenStatus);

    try {
      this.upsertStatement.run(
        parsedGreenStatus.object_id,
        parsedGreenStatus.object_kind,
        parsedGreenStatus.schema_version,
        parsedGreenStatus.lifecycle_state,
        parsedGreenStatus.created_at,
        parsedGreenStatus.updated_at,
        parsedGreenStatus.created_by,
        parsedGreenStatus.target_object_id,
        parsedGreenStatus.target_object_kind,
        parsedGreenStatus.green_state,
        parsedGreenStatus.verification_basis,
        parsedGreenStatus.verified_by,
        parsedGreenStatus.verified_at,
        parsedGreenStatus.valid_until,
        JSON.stringify(parsedGreenStatus.bound_surfaces),
        parsedGreenStatus.bound_scope_class,
        parsedGreenStatus.revoke_reason,
        parsedGreenStatus.last_transition_at,
        parsedGreenStatus.workspace_id
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to upsert green status ${parsedGreenStatus.object_id}.`,
        error
      );
    }

    return parsedGreenStatus;
  }

  public async delete(objectId: string): Promise<void> {
    const parsedObjectId = parseNonEmptyString(objectId, "green status object id");

    try {
      this.deleteStatement.run(parsedObjectId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to delete green status ${parsedObjectId}.`, error);
    }
  }

  private async findByState(
    statement: { all(workspaceId: string): unknown },
    workspaceId: string,
    stateName: string
  ): Promise<readonly Readonly<GreenStatus>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = statement.all(parsedWorkspaceId) as GreenStatusRow[];
      return rows.map((row) => parseGreenStatusRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list ${stateName} green statuses for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function parseGreenStatus(value: unknown): Readonly<GreenStatus> {
  try {
    return deepFreeze(GreenStatusSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate green status.", error);
  }
}

function parseGreenStatusRow(row: GreenStatusRow): Readonly<GreenStatus> {
  let parsedBoundSurfaces: GreenStatus["bound_surfaces"];

  try {
    parsedBoundSurfaces = JSON.parse(row.bound_surfaces) as GreenStatus["bound_surfaces"];
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse green status bound_surfaces JSON.", error);
  }

  return parseGreenStatus({
    object_id: parseNonEmptyString(row.object_id, "green status object id"),
    object_kind: row.object_kind,
    schema_version: row.schema_version,
    lifecycle_state: row.lifecycle_state,
    created_at: parseTimestamp(row.created_at),
    updated_at: parseTimestamp(row.updated_at),
    created_by: parseNonEmptyString(row.created_by, "green status created_by"),
    target_object_id: parseNonEmptyString(row.target_object_id, "target object id"),
    target_object_kind: row.target_object_kind,
    green_state: row.green_state,
    verification_basis: row.verification_basis,
    verified_by: row.verified_by,
    verified_at: parseNullableString(row.verified_at, "verified_at"),
    valid_until: parseNullableString(row.valid_until, "valid_until"),
    bound_surfaces:
      parsedBoundSurfaces === null ? null : Object.freeze([...parsedBoundSurfaces]),
    bound_scope_class: row.bound_scope_class,
    revoke_reason: row.revoke_reason,
    last_transition_at: parseTimestamp(row.last_transition_at),
    workspace_id: parseNonEmptyString(row.workspace_id, "workspace id")
  });
}
