import { SurfaceAnchorSchema, type EventLogEntry, type SurfaceAnchor } from "@do-what/protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "./shared/event-log-writer.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface SurfaceAnchorRepo {
  create(anchor: Readonly<SurfaceAnchor>): Promise<Readonly<SurfaceAnchor>>;
  createWithEvent(
    anchor: Readonly<SurfaceAnchor>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ anchor: Readonly<SurfaceAnchor>; event: EventLogEntry }>>;
  findById(objectId: string): Promise<Readonly<SurfaceAnchor> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]>;
  delete(objectId: string): Promise<void>;
  deleteWithEvent(
    objectId: string,
    event: EventLogDraftInput
  ): Promise<Readonly<EventLogEntry>>;
}

const SURFACE_ANCHOR_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        surface_id,
        anchor_kind,
        anchor_value,
        workspace_id
`;

interface SurfaceAnchorRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly surface_id: string;
  readonly anchor_kind: string;
  readonly anchor_value: string;
  readonly workspace_id: string;
}

export class SqliteSurfaceAnchorRepo implements SurfaceAnchorRepo {
  private readonly createStatement;
  private readonly eventLogWriter;
  private readonly findByIdStatement;
  private readonly findBySurfaceIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly deleteStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO surface_anchors (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        surface_id,
        anchor_kind,
        anchor_value,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${SURFACE_ANCHOR_SELECT_COLUMNS}
      FROM surface_anchors
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findBySurfaceIdStatement = db.connection.prepare(`
      SELECT${SURFACE_ANCHOR_SELECT_COLUMNS}
      FROM surface_anchors
      WHERE surface_id = ? AND workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${SURFACE_ANCHOR_SELECT_COLUMNS}
      FROM surface_anchors
      WHERE workspace_id = ?
      ORDER BY created_at ASC, object_id ASC
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM surface_anchors
      WHERE object_id = ?
    `);
  }

  public async create(anchor: Readonly<SurfaceAnchor>): Promise<Readonly<SurfaceAnchor>> {
    const parsedAnchor = parseSurfaceAnchor(anchor);

    try {
      this.createStatement.run(
        parsedAnchor.object_id,
        parsedAnchor.object_kind,
        parsedAnchor.schema_version,
        parsedAnchor.lifecycle_state,
        parsedAnchor.created_at,
        parsedAnchor.updated_at,
        parsedAnchor.created_by,
        parsedAnchor.surface_id,
        parsedAnchor.anchor_kind,
        parsedAnchor.anchor_value,
        parsedAnchor.workspace_id
      );
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create surface anchor ${parsedAnchor.object_id}.`, error);
    }

    return parsedAnchor;
  }

  public async createWithEvent(
    anchor: Readonly<SurfaceAnchor>,
    event: EventLogDraftInput
  ): Promise<Readonly<{ anchor: Readonly<SurfaceAnchor>; event: EventLogEntry }>> {
    const parsedAnchor = parseSurfaceAnchor(anchor);

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);

        this.createStatement.run(
          parsedAnchor.object_id,
          parsedAnchor.object_kind,
          parsedAnchor.schema_version,
          parsedAnchor.lifecycle_state,
          parsedAnchor.created_at,
          parsedAnchor.updated_at,
          parsedAnchor.created_by,
          parsedAnchor.surface_id,
          parsedAnchor.anchor_kind,
          parsedAnchor.anchor_value,
          parsedAnchor.workspace_id
        );

        return {
          anchor: parsedAnchor,
          event: storedEvent
        };
      })();
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create surface anchor ${parsedAnchor.object_id}.`, error);
    }
  }

  public async findById(objectId: string): Promise<Readonly<SurfaceAnchor> | null> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface anchor object id");

    try {
      const row = this.findByIdStatement.get(parsedObjectId) as SurfaceAnchorRow | undefined;
      return row === undefined ? null : parseSurfaceAnchorRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load surface anchor ${parsedObjectId}.`, error);
    }
  }

  public async findBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceAnchor>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findBySurfaceIdStatement.all(parsedSurfaceId, parsedWorkspaceId) as SurfaceAnchorRow[];
      return rows.map((row) => parseSurfaceAnchorRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list surface anchors for surface ${parsedSurfaceId}.`,
        error
      );
    }
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

    try {
      const rows = this.findByWorkspaceStatement.all(parsedWorkspaceId) as SurfaceAnchorRow[];
      return rows.map((row) => parseSurfaceAnchorRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list surface anchors for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async delete(objectId: string): Promise<void> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface anchor object id");

    try {
      const result = this.deleteStatement.run(parsedObjectId);

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Surface anchor ${parsedObjectId} was not found.`);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to delete surface anchor ${parsedObjectId}.`, error);
    }
  }

  public async deleteWithEvent(
    objectId: string,
    event: EventLogDraftInput
  ): Promise<Readonly<EventLogEntry>> {
    const parsedObjectId = parseNonEmptyString(objectId, "surface anchor object id");

    try {
      return this.db.connection.transaction(() => {
        const storedEvent = insertEventLogEntry(this.eventLogWriter, event);
        const result = this.deleteStatement.run(parsedObjectId);

        if (result.changes === 0) {
          throw new StorageError("NOT_FOUND", `Surface anchor ${parsedObjectId} was not found.`);
        }

        return storedEvent;
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to delete surface anchor ${parsedObjectId}.`, error);
    }
  }
}

function parseSurfaceAnchor(value: SurfaceAnchor): Readonly<SurfaceAnchor> {
  try {
    return deepFreeze(SurfaceAnchorSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface anchor.", error);
  }
}

function parseSurfaceAnchorRow(row: SurfaceAnchorRow): Readonly<SurfaceAnchor> {
  try {
    return deepFreeze(
      SurfaceAnchorSchema.parse({
        object_id: row.object_id,
        object_kind: row.object_kind,
        schema_version: row.schema_version,
        lifecycle_state: row.lifecycle_state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by,
        surface_id: row.surface_id,
        anchor_kind: row.anchor_kind,
        anchor_value: row.anchor_value,
        workspace_id: row.workspace_id
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate surface anchor row.", error);
  }
}
