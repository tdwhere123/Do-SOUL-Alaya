import {
  BindingStateSchema,
  SurfaceBindingSchema,
  type BindingState,
  type SurfaceBinding
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface SurfaceBindingRecord {
  readonly binding_id: string;
  readonly binding: Readonly<SurfaceBinding>;
}

export interface SurfaceBindingRepo {
  create(binding: Readonly<SurfaceBinding>, bindingId: string): Promise<Readonly<SurfaceBindingRecord>>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  createSync(binding: Readonly<SurfaceBinding>, bindingId: string): Readonly<SurfaceBindingRecord>;
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
  ): Promise<Readonly<SurfaceBindingRecord>>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  updateStateSync(
    bindingId: string,
    bindingState: BindingState,
    updatedAt: string
  ): Readonly<SurfaceBindingRecord>;
  cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]>;
  /** Sync sibling for atomic publish + mutation (#BL-022). */
  cascadeDetachBySurfaceIdSync(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): readonly Readonly<SurfaceBindingRecord>[];
}

const SURFACE_BINDING_SELECT_COLUMNS = `
        binding_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        surface_id,
        is_primary,
        binding_state,
        workspace_id
`;

interface SurfaceBindingRow {
  readonly binding_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly object_id: string;
  readonly surface_id: string;
  readonly is_primary: number;
  readonly binding_state: string;
  readonly workspace_id: string;
}

export class SqliteSurfaceBindingRepo implements SurfaceBindingRepo {
  private readonly createStatement;
  private readonly findByBindingIdStatement;
  private readonly findByObjectIdStatement;
  private readonly findPrimaryBindingStatement;
  private readonly findBySurfaceIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly updateStateStatement;
  private readonly findDetachableBySurfaceIdStatement;
  private readonly findDetachedBySurfaceIdStatement;
  private readonly cascadeDetachStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO surface_bindings (
        binding_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        surface_id,
        is_primary,
        binding_state,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByBindingIdStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE binding_id = ?
      LIMIT 1
    `);

    this.findByObjectIdStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE object_id = ? AND workspace_id = ?
      ORDER BY created_at ASC, binding_id ASC
    `);

    this.findPrimaryBindingStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE object_id = ? AND workspace_id = ? AND is_primary = 1 AND binding_state != 'detached'
      LIMIT 1
    `);

    this.findBySurfaceIdStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE surface_id = ? AND workspace_id = ?
      ORDER BY created_at ASC, binding_id ASC
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE workspace_id = ?
      ORDER BY created_at ASC, binding_id ASC
    `);

    this.updateStateStatement = db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = ?, updated_at = ?
      WHERE binding_id = ?
    `);

    this.findDetachableBySurfaceIdStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE surface_id = ? AND workspace_id = ? AND binding_state != 'detached'
      ORDER BY created_at ASC, binding_id ASC
    `);

    this.findDetachedBySurfaceIdStatement = db.connection.prepare(`
      SELECT${SURFACE_BINDING_SELECT_COLUMNS}
      FROM surface_bindings
      WHERE surface_id = ? AND workspace_id = ? AND binding_state = 'detached'
      ORDER BY created_at ASC, binding_id ASC
    `);

    this.cascadeDetachStatement = db.connection.prepare(`
      UPDATE surface_bindings
      SET binding_state = 'detached', updated_at = ?
      WHERE surface_id = ? AND workspace_id = ? AND binding_state != 'detached'
    `);
  }

  public async create(
    binding: Readonly<SurfaceBinding>,
    bindingId: string
  ): Promise<Readonly<SurfaceBindingRecord>> {
    return this.createSync(binding, bindingId);
  }

  /** Synchronous variant for atomic publish + mutation (#BL-022). */
  public createSync(
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
      const row = this.findByBindingIdStatement.get(parsedBindingId) as SurfaceBindingRow | undefined;
      return row === undefined ? null : parseSurfaceBindingRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load surface binding ${parsedBindingId}.`, error);
    }
  }

  public async findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByObjectIdStatement.all(parsedObjectId, parsedWorkspaceId) as SurfaceBindingRow[];
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load surface bindings for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findPrimaryBinding(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<SurfaceBindingRecord> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findPrimaryBindingStatement.get(
        parsedObjectId,
        parsedWorkspaceId
      ) as SurfaceBindingRow | undefined;
      return row === undefined ? null : parseSurfaceBindingRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load primary binding for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId) as SurfaceBindingRow[];
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load surface bindings for surface ${parsedSurfaceId}.`,
        error
      );
    }
  }

  public async findDetachableBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findDetachableBySurfaceIdStatement.all(
        parsedSurfaceId,
        parsedWorkspaceId
      ) as SurfaceBindingRow[];
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load detachable bindings for surface ${parsedSurfaceId}.`,
        error
      );
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as SurfaceBindingRow[];
      return rows.map((row) => parseSurfaceBindingRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list surface bindings for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async updateState(
    bindingId: string,
    bindingState: BindingState,
    updatedAt: string
  ): Promise<Readonly<SurfaceBindingRecord>> {
    return this.updateStateSync(bindingId, bindingState, updatedAt);
  }

  /** Synchronous variant for atomic publish + mutation (#BL-022). */
  public updateStateSync(
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

      const row = this.findByBindingIdStatement.get(parsedBindingId) as SurfaceBindingRow | undefined;

      if (row === undefined) {
        throw new StorageError("NOT_FOUND", `Surface binding ${parsedBindingId} was not found after update.`);
      }

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

  public async cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): Promise<readonly Readonly<SurfaceBindingRecord>[]> {
    // Legacy async callers still need their own transaction wrapper; the new
    // sync sibling assumes the caller already opened one (e.g. via
    // EventPublisher.appendManyWithMutation -> repo.transactional()).
    return this.db.connection.transaction(() =>
      this.cascadeDetachBySurfaceIdSync(surfaceId, workspaceId, updatedAt)
    )();
  }

  /**
   * Synchronous variant for atomic publish + mutation (#BL-022). When called
   * from inside `EventPublisher.appendManyWithMutation`, the outer
   * `transactional()` wrapper already opens a SQLite transaction, so we run
   * the row read/update without our own `db.connection.transaction(...)`.
   * Better-sqlite3's `transaction()` is reentrant via SAVEPOINT but unwrapping
   * keeps the call shape identical to the other Sync siblings.
   */
  public cascadeDetachBySurfaceIdSync(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): readonly Readonly<SurfaceBindingRecord>[] {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const rows = this.findDetachableBySurfaceIdStatement.all(
        parsedSurfaceId,
        parsedWorkspaceId
      ) as SurfaceBindingRow[];

      if (rows.length === 0) {
        return [];
      }

      const targetBindingIds = rows.map((row) => row.binding_id);

      this.cascadeDetachStatement.run(parsedUpdatedAt, parsedSurfaceId, parsedWorkspaceId);

      const updatedRows = this.findDetachedBySurfaceIdStatement.all(
        parsedSurfaceId,
        parsedWorkspaceId
      ) as SurfaceBindingRow[];
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
