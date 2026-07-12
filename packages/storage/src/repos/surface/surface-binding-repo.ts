import {
  BindingStateSchema,
  SurfaceBindingSchema,
  type BindingState,
  type SurfaceBinding
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseOptionalRow, parseRow, parseRows } from "../shared/parse-row.js";
import {
  SurfaceBindingRowParser,
  type SurfaceBindingRow
} from "../shared/sqlite-row-schemas.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import { prepareSurfaceBindingStatements, type SqliteStatement } from "./surface-binding-statements.js";

export interface SurfaceBindingRecord {
  readonly binding_id: string;
  readonly binding: Readonly<SurfaceBinding>;
}

export interface SurfaceBindingRepo {
  create(binding: Readonly<SurfaceBinding>, bindingId: string): Readonly<SurfaceBindingRecord>;
  findByBindingId(bindingId: string): Promise<Readonly<SurfaceBindingRecord> | null>;
  findByObjectId(objectId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecord>[]>;
  findPrimaryBinding(objectId: string, workspaceId: string): Promise<Readonly<SurfaceBindingRecord> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecord>[]>;
  findDetachableBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecord>[]>;
  updateState(
    bindingId: string,
    bindingState: BindingState,
    updatedAt: string
  ): Readonly<SurfaceBindingRecord>;
  cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): readonly Readonly<SurfaceBindingRecord>[];
}

export class SqliteSurfaceBindingRepo implements SurfaceBindingRepo {
  private readonly createStatement: SqliteStatement;
  private readonly findByBindingIdStatement: SqliteStatement;
  private readonly findByObjectIdStatement: SqliteStatement;
  private readonly findPrimaryBindingStatement: SqliteStatement;
  private readonly findBySurfaceIdStatement: SqliteStatement;
  private readonly findByWorkspaceStatement: SqliteStatement;
  private readonly updateStateStatement: SqliteStatement;
  private readonly findDetachableBySurfaceIdStatement: SqliteStatement;
  private readonly findDetachedBySurfaceIdStatement: SqliteStatement;
  private readonly cascadeDetachStatement: SqliteStatement;

  public constructor(db: StorageDatabase) {
    const statements = prepareSurfaceBindingStatements(db);
    this.createStatement = statements.createStatement;
    this.findByBindingIdStatement = statements.findByBindingIdStatement;
    this.findByObjectIdStatement = statements.findByObjectIdStatement;
    this.findPrimaryBindingStatement = statements.findPrimaryBindingStatement;
    this.findBySurfaceIdStatement = statements.findBySurfaceIdStatement;
    this.findByWorkspaceStatement = statements.findByWorkspaceStatement;
    this.updateStateStatement = statements.updateStateStatement;
    this.findDetachableBySurfaceIdStatement = statements.findDetachableBySurfaceIdStatement;
    this.findDetachedBySurfaceIdStatement = statements.findDetachedBySurfaceIdStatement;
    this.cascadeDetachStatement = statements.cascadeDetachStatement;
  }

  public create(
    binding: Readonly<SurfaceBinding>,
    bindingId: string
  ): Readonly<SurfaceBindingRecord> {
    const parsedBinding = parseSurfaceBinding(binding);
    const parsedBindingId = parseNonEmptyString(bindingId, "binding id");

    try {
      this.createStatement.run(
        parsedBindingId,
        parsedBinding.object_kind,
        parsedBinding.schema_version,
        parsedBinding.lifecycle_state,
        parsedBinding.created_at,
        parsedBinding.updated_at,
        parsedBinding.created_by,
        parsedBinding.object_id,
        parsedBinding.surface_id,
        parsedBinding.is_primary ? 1 : 0,
        parsedBinding.binding_state,
        parsedBinding.workspace_id
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create surface binding ${parsedBindingId}.`,
        error
      );
    }

    return parseSurfaceBindingRecord(parsedBindingId, parsedBinding);
  }

  public async findByBindingId(bindingId: string): Promise<Readonly<SurfaceBindingRecord> | null> {
    const parsedBindingId = parseNonEmptyString(bindingId, "binding id");

    try {
      const row = parseOptionalRow(
        this.findByBindingIdStatement.get(parsedBindingId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return row === null ? null : parseSurfaceBindingRow(row);
    } catch (error) {
      rethrowQueryFailure(error, `Failed to load surface binding ${parsedBindingId}.`);
    }
  }

  public async findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = parseRows(
        this.findByObjectIdStatement.all(parsedObjectId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      rethrowQueryFailure(error, `Failed to load surface bindings for object ${parsedObjectId}.`);
    }
  }

  public async findPrimaryBinding(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<SurfaceBindingRecord> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = parseOptionalRow(
        this.findPrimaryBindingStatement.get(parsedObjectId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return row === null ? null : parseSurfaceBindingRow(row);
    } catch (error) {
      rethrowQueryFailure(error, `Failed to load primary binding for object ${parsedObjectId}.`);
    }
  }

  public async findBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = parseRows(
        this.findBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      rethrowQueryFailure(error, `Failed to load surface bindings for surface ${parsedSurfaceId}.`);
    }
  }

  public async findDetachableBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = parseRows(
        this.findDetachableBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      rethrowQueryFailure(error, `Failed to load detachable bindings for surface ${parsedSurfaceId}.`);
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = parseRows(
        this.findByWorkspaceStatement.all(parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      rethrowQueryFailure(error, `Failed to list surface bindings for workspace ${parsedWorkspaceId}.`);
    }
  }

  public updateState(
    bindingId: string,
    bindingState: BindingState,
    updatedAt: string
  ): Readonly<SurfaceBindingRecord> {
    const parsedBindingId = parseNonEmptyString(bindingId, "binding id");
    const parsedBindingState = parseBindingState(bindingState);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const result = this.updateStateStatement.run(parsedBindingState, parsedUpdatedAt, parsedBindingId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Surface binding ${parsedBindingId} was not found.`);
      }

      const row = parseRow(
        this.findByBindingIdStatement.get(parsedBindingId),
        SurfaceBindingRowParser,
        "surface binding row"
      );

      return parseSurfaceBindingRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update surface binding ${parsedBindingId}.`,
        error
      );
    }
  }

  public cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): readonly Readonly<SurfaceBindingRecord>[] {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const rows = parseRows(
        this.findDetachableBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );

      if (rows.length === 0) {
        return [];
      }

      const targetBindingIds = rows.map((row) => row.binding_id);

      this.cascadeDetachStatement.run(parsedUpdatedAt, parsedSurfaceId, parsedWorkspaceId);

      const updatedRows = parseRows(
        this.findDetachedBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId),
        SurfaceBindingRowParser,
        "surface binding row"
      );
      const rowById = new Map(updatedRows.map((row) => [row.binding_id, row]));

      return targetBindingIds
        .map((bindingId) => rowById.get(bindingId))
        .filter((row): row is SurfaceBindingRow => row !== undefined)
        .map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to cascade detach bindings for surface ${parsedSurfaceId}.`,
        error
      );
    }
  }

}

function rethrowQueryFailure(error: unknown, message: string): never {
  if (error instanceof StorageError) {
    throw error;
  }

  throw new StorageError("QUERY_FAILED", message, error);
}

function parseSurfaceBinding(value: Readonly<SurfaceBinding>): Readonly<SurfaceBinding> {
  try {
    return deepFreeze(SurfaceBindingSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface binding.", error);
  }
}

function parseBindingState(value: BindingState): BindingState {
  try {
    return BindingStateSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate binding state.", error);
  }
}

function parseSurfaceBindingRow(row: SurfaceBindingRow): Readonly<SurfaceBindingRecord> {
  try {
    const binding = deepFreeze(
      SurfaceBindingSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        surface_id: row.surface_id,
        is_primary: row.is_primary === 1,
        binding_state: row.binding_state,
        workspace_id: row.workspace_id
      })
    );

    return parseSurfaceBindingRecord(row.binding_id, binding);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface binding row.", error);
  }
}

function parseSurfaceBindingRecord(
  bindingId: string,
  binding: Readonly<SurfaceBinding>
): Readonly<SurfaceBindingRecord> {
  return deepFreeze({
    binding_id: parseNonEmptyString(bindingId, "binding id"),
    binding
  });
}
