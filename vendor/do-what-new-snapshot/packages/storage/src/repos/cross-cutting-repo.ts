import {
  CrossCuttingPermissionSchema,
  CrossCuttingStateSchema,
  type EventLogEntry,
  type CrossCuttingPermission,
  type CrossCuttingState
} from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "./shared/event-log-writer.js";
import { parseNonEmptyString, parseSurfaceUri, parseTimestamp } from "./shared/validators.js";

export interface CrossCuttingPermissionRecord {
  readonly permission_id: string;
  readonly permission: Readonly<CrossCuttingPermission>;
}

export interface CrossCuttingPermissionRepo {
  create(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string
  ): Promise<Readonly<CrossCuttingPermissionRecord>>;
  createWithEvent(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecord>; event: EventLogEntry }>>;
  findByPermissionId(permissionId: string): Promise<Readonly<CrossCuttingPermissionRecord> | null>;
  findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<CrossCuttingPermissionRecord> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<CrossCuttingPermissionRecord>[]>;
  updateState(
    permissionId: string,
    crossCuttingState: CrossCuttingState,
    allowedSurfaces: readonly string[],
    updatedAt: string
  ): Promise<Readonly<CrossCuttingPermissionRecord>>;
  updateStateWithEvent(
    permissionId: string,
    crossCuttingState: CrossCuttingState,
    allowedSurfaces: readonly string[],
    updatedAt: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecord>; event: EventLogEntry }>>;
}

const CROSS_CUTTING_PERMISSION_SELECT_COLUMNS = `
        permission_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        cross_cutting_state,
        allowed_surfaces,
        workspace_id
`;

interface CrossCuttingPermissionRow {
  readonly permission_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly object_id: string;
  readonly cross_cutting_state: string;
  readonly allowed_surfaces: string;
  readonly workspace_id: string;
}

export class SqliteCrossCuttingPermissionRepo implements CrossCuttingPermissionRepo {
  private readonly createStatement;
  private readonly eventLogWriter;
  private readonly findByPermissionIdStatement;
  private readonly findByObjectIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly updateStateStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO cross_cutting_permissions (
        permission_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        object_id,
        cross_cutting_state,
        allowed_surfaces,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);

    this.findByPermissionIdStatement = db.connection.prepare(`
      SELECT${CROSS_CUTTING_PERMISSION_SELECT_COLUMNS}
      FROM cross_cutting_permissions
      WHERE permission_id = ?
      LIMIT 1
    `);

    this.findByObjectIdStatement = db.connection.prepare(`
      SELECT${CROSS_CUTTING_PERMISSION_SELECT_COLUMNS}
      FROM cross_cutting_permissions
      WHERE object_id = ? AND workspace_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${CROSS_CUTTING_PERMISSION_SELECT_COLUMNS}
      FROM cross_cutting_permissions
      WHERE workspace_id = ?
      ORDER BY created_at ASC, permission_id ASC
    `);

    this.updateStateStatement = db.connection.prepare(`
      UPDATE cross_cutting_permissions
      SET cross_cutting_state = ?, allowed_surfaces = ?, updated_at = ?
      WHERE permission_id = ?
    `);
  }

  public async create(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string
  ): Promise<Readonly<CrossCuttingPermissionRecord>> {
    const parsedPermission = parseCrossCuttingPermission(permission);
    const parsedPermissionId = parseNonEmptyString(permissionId, "permission id");

    try {
      this.createStatement.run(
        parsedPermissionId,
        parsedPermission.object_kind,
        parsedPermission.schema_version,
        parsedPermission.lifecycle_state,
        parsedPermission.created_at,
        parsedPermission.updated_at,
        parsedPermission.created_by,
        parsedPermission.object_id,
        parsedPermission.cross_cutting_state,
        JSON.stringify(parsedPermission.allowed_surfaces),
        parsedPermission.workspace_id
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create cross cutting permission ${parsedPermissionId}.`,
        error
      );
    }

    return parseCrossCuttingPermissionRecord(parsedPermissionId, parsedPermission);
  }

  public async createWithEvent(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecord>; event: EventLogEntry }>> {
    const parsedPermission = parseCrossCuttingPermission(permission);
    const parsedPermissionId = parseNonEmptyString(permissionId, "permission id");

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);

        this.createStatement.run(
          parsedPermissionId,
          parsedPermission.object_kind,
          parsedPermission.schema_version,
          parsedPermission.lifecycle_state,
          parsedPermission.created_at,
          parsedPermission.updated_at,
          parsedPermission.created_by,
          parsedPermission.object_id,
          parsedPermission.cross_cutting_state,
          JSON.stringify(parsedPermission.allowed_surfaces),
          parsedPermission.workspace_id
        );

        return {
          record: parseCrossCuttingPermissionRecord(parsedPermissionId, parsedPermission),
          event: storedEvent
        };
      })();
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create cross cutting permission ${parsedPermissionId}.`,
        error
      );
    }
  }

  public async findByPermissionId(
    permissionId: string
  ): Promise<Readonly<CrossCuttingPermissionRecord> | null> {
    const parsedPermissionId = parseNonEmptyString(permissionId, "permission id");

    try {
      const row = this.findByPermissionIdStatement.get(
        parsedPermissionId
      ) as CrossCuttingPermissionRow | undefined;
      return row === undefined ? null : parseCrossCuttingPermissionRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load cross cutting permission ${parsedPermissionId}.`,
        error
      );
    }
  }

  public async findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<CrossCuttingPermissionRecord> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "object id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findByObjectIdStatement.get(
        parsedObjectId,
        parsedWorkspaceId
      ) as CrossCuttingPermissionRow | undefined;
      return row === undefined ? null : parseCrossCuttingPermissionRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load cross cutting permission for object ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<CrossCuttingPermissionRecord>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as CrossCuttingPermissionRow[];
      return rows.map((row) => parseCrossCuttingPermissionRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list cross cutting permissions for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async updateState(
    permissionId: string,
    crossCuttingState: CrossCuttingState,
    allowedSurfaces: readonly string[],
    updatedAt: string
  ): Promise<Readonly<CrossCuttingPermissionRecord>> {
    const parsedPermissionId = parseNonEmptyString(permissionId, "permission id");
    const parsedState = parseCrossCuttingState(crossCuttingState);
    const parsedAllowedSurfaces = parseAllowedSurfaces(allowedSurfaces);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const result = this.updateStateStatement.run(
        parsedState,
        JSON.stringify(parsedAllowedSurfaces),
        parsedUpdatedAt,
        parsedPermissionId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Cross cutting permission ${parsedPermissionId} was not found.`);
      }

      const updated = await this.findByPermissionId(parsedPermissionId);

      if (updated === null) {
        throw new StorageError(
          "NOT_FOUND",
          `Cross cutting permission ${parsedPermissionId} was not found after update.`
        );
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update cross cutting permission ${parsedPermissionId}.`,
        error
      );
    }
  }

  public async updateStateWithEvent(
    permissionId: string,
    crossCuttingState: CrossCuttingState,
    allowedSurfaces: readonly string[],
    updatedAt: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecord>; event: EventLogEntry }>> {
    const parsedPermissionId = parseNonEmptyString(permissionId, "permission id");
    const parsedState = parseCrossCuttingState(crossCuttingState);
    const parsedAllowedSurfaces = parseAllowedSurfaces(allowedSurfaces);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);
        const result = this.updateStateStatement.run(
          parsedState,
          JSON.stringify(parsedAllowedSurfaces),
          parsedUpdatedAt,
          parsedPermissionId
        );

        if (result.changes === 0) {
          throw new StorageError("NOT_FOUND", `Cross cutting permission ${parsedPermissionId} was not found.`);
        }

        const row = this.findByPermissionIdStatement.get(
          parsedPermissionId
        ) as CrossCuttingPermissionRow | undefined;

        if (row === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Cross cutting permission ${parsedPermissionId} was not found after update.`
          );
        }

        return {
          record: parseCrossCuttingPermissionRow(row),
          event: storedEvent
        };
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update cross cutting permission ${parsedPermissionId}.`,
        error
      );
    }
  }
}

function parseCrossCuttingPermission(
  value: Readonly<CrossCuttingPermission>
): Readonly<CrossCuttingPermission> {
  try {
    return deepFreeze(CrossCuttingPermissionSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate cross cutting permission.", error);
  }
}

function parseCrossCuttingState(value: CrossCuttingState): CrossCuttingState {
  try {
    return CrossCuttingStateSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate cross_cutting_state.", error);
  }
}

function parseAllowedSurfaces(value: readonly string[]): readonly string[] {
  try {
    return deepFreeze(value.map((surfaceId) => parseSurfaceUri(surfaceId, "allowed_surfaces")));
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", "Failed to validate allowed_surfaces.", error);
  }
}

function parseAllowedSurfacesJson(value: string): readonly string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse allowed_surfaces JSON.", error);
  }

  if (!Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "allowed_surfaces must deserialize to a string array.");
  }

  if (!parsed.every((entry) => typeof entry === "string")) {
    throw new StorageError("VALIDATION_FAILED", "allowed_surfaces must deserialize to a string array.");
  }

  return parseAllowedSurfaces(parsed);
}

function parseCrossCuttingPermissionRow(
  row: CrossCuttingPermissionRow
): Readonly<CrossCuttingPermissionRecord> {
  try {
    const permission = deepFreeze(
      CrossCuttingPermissionSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        cross_cutting_state: row.cross_cutting_state,
        allowed_surfaces: parseAllowedSurfacesJson(row.allowed_surfaces),
        workspace_id: row.workspace_id
      })
    );

    return parseCrossCuttingPermissionRecord(row.permission_id, permission);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", "Failed to validate cross cutting permission row.", error);
  }
}

function parseCrossCuttingPermissionRecord(
  permissionId: string,
  permission: Readonly<CrossCuttingPermission>
): Readonly<CrossCuttingPermissionRecord> {
  return deepFreeze({
    permission_id: parseNonEmptyString(permissionId, "permission id"),
    permission
  });
}
