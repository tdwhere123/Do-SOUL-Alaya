import {
  SurfaceIdentitySchema,
  SurfaceStatusSchema,
  type EventLogEntry,
  type SurfaceIdentity,
  type SurfaceStatus
} from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "./shared/event-log-writer.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface SurfaceIdentityRepo {
  create(identity: Readonly<SurfaceIdentity>): Promise<Readonly<SurfaceIdentity>>;
  createWithEvent(
    identity: Readonly<SurfaceIdentity>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>>;
  findById(objectId: string): Promise<Readonly<SurfaceIdentity> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]>;
  updateStatus(
    objectId: string,
    surfaceStatus: SurfaceStatus,
    updatedAt: string
  ): Promise<Readonly<SurfaceIdentity>>;
  updateStatusWithEvent(
    objectId: string,
    surfaceStatus: SurfaceStatus,
    updatedAt: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>>;
}

const SURFACE_IDENTITY_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        surface_id,
        surface_kind,
        surface_status,
        workspace_id
`;

interface SurfaceIdentityRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly surface_id: string;
  readonly surface_kind: string;
  readonly surface_status: string;
  readonly workspace_id: string;
}

export class SqliteSurfaceIdentityRepo implements SurfaceIdentityRepo {
  private readonly createStatement;
  private readonly eventLogWriter;
  private readonly findByIdStatement;
  private readonly findBySurfaceIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly updateStatusStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO surface_identities (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        surface_id,
        surface_kind,
        surface_status,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${SURFACE_IDENTITY_SELECT_COLUMNS}
      FROM surface_identities
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findBySurfaceIdStatement = db.connection.prepare(`
      SELECT${SURFACE_IDENTITY_SELECT_COLUMNS}
      FROM surface_identities
      WHERE surface_id = ? AND workspace_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${SURFACE_IDENTITY_SELECT_COLUMNS}
      FROM surface_identities
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.updateStatusStatement = db.connection.prepare(`
      UPDATE surface_identities
      SET surface_status = ?, updated_at = ?
      WHERE object_id = ?
    `);
  }

  public async create(identity: Readonly<SurfaceIdentity>): Promise<Readonly<SurfaceIdentity>> {
    const parsedIdentity = parseSurfaceIdentity(identity);

    try {
      this.createStatement.run(
        parsedIdentity.object_id,
        parsedIdentity.object_kind,
        parsedIdentity.schema_version,
        parsedIdentity.lifecycle_state,
        parsedIdentity.created_at,
        parsedIdentity.updated_at,
        parsedIdentity.created_by,
        parsedIdentity.surface_id,
        parsedIdentity.surface_kind,
        parsedIdentity.surface_status,
        parsedIdentity.workspace_id
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create surface identity ${parsedIdentity.object_id}.`,
        error
      );
    }

    return parsedIdentity;
  }

  public async createWithEvent(
    identity: Readonly<SurfaceIdentity>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>> {
    const parsedIdentity = parseSurfaceIdentity(identity);

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);

        this.createStatement.run(
          parsedIdentity.object_id,
          parsedIdentity.object_kind,
          parsedIdentity.schema_version,
          parsedIdentity.lifecycle_state,
          parsedIdentity.created_at,
          parsedIdentity.updated_at,
          parsedIdentity.created_by,
          parsedIdentity.surface_id,
          parsedIdentity.surface_kind,
          parsedIdentity.surface_status,
          parsedIdentity.workspace_id
        );

        return {
          identity: parsedIdentity,
          event: storedEvent
        };
      })();
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create surface identity ${parsedIdentity.object_id}.`,
        error
      );
    }
  }

  public async findById(objectId: string): Promise<Readonly<SurfaceIdentity> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface identity object id");

    try {
      const row = this.findByIdStatement.get(parsedObjectId) as SurfaceIdentityRow | undefined;
      return row === undefined ? null : parseSurfaceIdentityRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load surface identity ${parsedObjectId}.`, error);
    }
  }

  public async findBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<Readonly<SurfaceIdentity> | null> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const row = this.findBySurfaceIdStatement.get(
        parsedSurfaceId,
        parsedWorkspaceId
      ) as SurfaceIdentityRow | undefined;
      return row === undefined ? null : parseSurfaceIdentityRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load surface identity by surface_id ${parsedSurfaceId}.`,
        error
      );
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as SurfaceIdentityRow[];
      return rows.map((row) => parseSurfaceIdentityRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list surface identities for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async updateStatus(
    objectId: string,
    surfaceStatus: SurfaceStatus,
    updatedAt: string
  ): Promise<Readonly<SurfaceIdentity>> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface identity object id");
    const parsedSurfaceStatus = parseSurfaceStatus(surfaceStatus);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      const result = this.updateStatusStatement.run(parsedSurfaceStatus, parsedUpdatedAt, parsedObjectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Surface identity ${parsedObjectId} was not found.`);
      }

      const updated = await this.findById(parsedObjectId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Surface identity ${parsedObjectId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update status for surface identity ${parsedObjectId}.`,
        error
      );
    }
  }

  public async updateStatusWithEvent(
    objectId: string,
    surfaceStatus: SurfaceStatus,
    updatedAt: string,
    event: EventLogDraftInput
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface identity object id");
    const parsedSurfaceStatus = parseSurfaceStatus(surfaceStatus);
    const parsedUpdatedAt = parseTimestamp(updatedAt);

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);
        const result = this.updateStatusStatement.run(parsedSurfaceStatus, parsedUpdatedAt, parsedObjectId);

        if (result.changes === 0) {
          throw new StorageError("NOT_FOUND", `Surface identity ${parsedObjectId} was not found.`);
        }

        const row = this.findByIdStatement.get(parsedObjectId) as SurfaceIdentityRow | undefined;

        if (row === undefined) {
          throw new StorageError("NOT_FOUND", `Surface identity ${parsedObjectId} was not found after update.`);
        }

        return {
          identity: parseSurfaceIdentityRow(row),
          event: storedEvent
        };
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update status for surface identity ${parsedObjectId}.`,
        error
      );
    }
  }
}

function parseSurfaceIdentity(value: SurfaceIdentity): Readonly<SurfaceIdentity> {
  try {
    return deepFreeze(SurfaceIdentitySchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface identity.", error);
  }
}

function parseSurfaceStatus(value: SurfaceStatus): SurfaceStatus {
  try {
    return SurfaceStatusSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface status.", error);
  }
}

function parseSurfaceIdentityRow(row: SurfaceIdentityRow): Readonly<SurfaceIdentity> {
  try {
    return deepFreeze(
      SurfaceIdentitySchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        surface_id: row.surface_id,
        surface_kind: row.surface_kind,
        surface_status: row.surface_status,
        workspace_id: row.workspace_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface identity row.", error);
  }
}
