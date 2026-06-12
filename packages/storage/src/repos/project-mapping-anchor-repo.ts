import {
  ObjectKind,
  ObjectLifecycleStateSchema,
  ProjectMappingStateSchema,
  type ObjectLifecycleState,
  type ProjectMappingAnchor as ProtocolProjectMappingAnchor,
  type ProjectMappingState
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../sqlite/db.js";
import { StorageError } from "../shared/errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

const acceptedByValues = ["user", "review", "deterministic_rule"] as const;

export type AcceptedBy = (typeof acceptedByValues)[number];
export type ProjectMappingAnchorRecord = Readonly<
  ProtocolProjectMappingAnchor & {
    readonly accepted_by: AcceptedBy | null;
    readonly last_transition_at: string;
  }
>;

export interface ProjectMappingAnchorRepo {
  create(anchor: ProjectMappingAnchorRecord): Promise<void>;
  findById(objectId: string): Promise<Readonly<ProjectMappingAnchorRecord> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
  findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingState
  ): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
  findByGlobalObjectId(
    globalObjectId: string,
    workspaceId: string
  ): Promise<Readonly<ProjectMappingAnchorRecord> | null>;
  updateState(
    objectId: string,
    newState: ProjectMappingState,
    acceptedBy: AcceptedBy | null,
    transitionedAt: string
  ): Promise<void>;
  listPending(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
}

const PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        global_object_id,
        project_id,
        workspace_id,
        mapping_state,
        accepted_by,
        last_transition_at
`;

interface ProjectMappingAnchorRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly lifecycle_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string;
  readonly global_object_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly mapping_state: string;
  readonly accepted_by: string | null;
  readonly last_transition_at: string;
}

export class SqliteProjectMappingAnchorRepo implements ProjectMappingAnchorRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceStatement;
  private readonly findByWorkspaceAndStateStatement;
  private readonly findByGlobalObjectIdStatement;
  private readonly updateStateStatement;
  private readonly listPendingStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO project_mapping_anchors (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        global_object_id,
        project_id,
        workspace_id,
        mapping_state,
        accepted_by,
        last_transition_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE object_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceStatement = db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE workspace_id = ?
      ORDER BY last_transition_at DESC, object_id DESC
    `);

    this.findByWorkspaceAndStateStatement = db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE workspace_id = ? AND mapping_state = ?
      ORDER BY last_transition_at DESC, object_id DESC
    `);

    this.findByGlobalObjectIdStatement = db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE global_object_id = ? AND workspace_id = ?
      LIMIT 1
    `);

    this.updateStateStatement = db.connection.prepare(`
      UPDATE project_mapping_anchors
      SET mapping_state = ?, accepted_by = ?, last_transition_at = ?, updated_at = ?
      WHERE object_id = ?
    `);

    this.listPendingStatement = db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE workspace_id = ? AND mapping_state IN ('suggested', 'probationary')
      ORDER BY last_transition_at DESC, object_id DESC
    `);
  }

  public async create(anchor: ProjectMappingAnchorRecord): Promise<void> {
    const parsedAnchor = parseProjectMappingAnchor(anchor);

    try {
      this.createStatement.run(
        parsedAnchor.object_id,
        parsedAnchor.object_kind,
        parsedAnchor.schema_version,
        parsedAnchor.lifecycle_state,
        parsedAnchor.created_at,
        parsedAnchor.updated_at,
        parsedAnchor.created_by,
        parsedAnchor.global_object_id,
        parsedAnchor.project_id,
        parsedAnchor.workspace_id,
        parsedAnchor.mapping_state,
        parsedAnchor.accepted_by,
        parsedAnchor.last_transition_at
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create project mapping anchor ${parsedAnchor.object_id}.`,
        error
      );
    }
  }

  public async findById(objectId: string): Promise<Readonly<ProjectMappingAnchorRecord> | null> {
    const parsedObjectId = parseObjectId(objectId);

    try {
      const row = this.findByIdStatement.get(parsedObjectId) as ProjectMappingAnchorRow | undefined;
      return row === undefined ? null : parseProjectMappingAnchorRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load project mapping anchor ${parsedObjectId}.`,
        error
      );
    }
  }

  public async findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]> {
    const parsedObjectIds = Array.from(new Set(objectIds.map((objectId) => parseObjectId(objectId))));

    if (parsedObjectIds.length === 0) {
      return [];
    }

    const placeholders = parsedObjectIds.map(() => "?").join(", ");
    const statement = this.db.connection.prepare(`
      SELECT${PROJECT_MAPPING_ANCHOR_SELECT_COLUMNS}
      FROM project_mapping_anchors
      WHERE object_id IN (${placeholders})
      ORDER BY created_at ASC, object_id ASC
    `);

    try {
      const rows = statement.all(...parsedObjectIds) as ProjectMappingAnchorRow[];
      return rows.map((row) => parseProjectMappingAnchorRow(row));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load project mapping anchors by ids.", error);
    }
  }

  public async findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingState
  ): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const parsedState = state === undefined ? undefined : parseProjectMappingState(state);

    try {
      const rows =
        parsedState === undefined
          ? (this.findByWorkspaceStatement.all(parsedWorkspaceId) as ProjectMappingAnchorRow[])
          : (this.findByWorkspaceAndStateStatement.all(
              parsedWorkspaceId,
              parsedState
            ) as ProjectMappingAnchorRow[]);

      return rows.map((row) => parseProjectMappingAnchorRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list project mapping anchors for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findByGlobalObjectId(
    globalObjectId: string,
    workspaceId: string
  ): Promise<Readonly<ProjectMappingAnchorRecord> | null> {
    const parsedGlobalObjectId = parseGlobalObjectId(globalObjectId);
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const row = this.findByGlobalObjectIdStatement.get(
        parsedGlobalObjectId,
        parsedWorkspaceId
      ) as ProjectMappingAnchorRow | undefined;

      return row === undefined ? null : parseProjectMappingAnchorRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load project mapping anchor for global object ${parsedGlobalObjectId}.`,
        error
      );
    }
  }

  public async updateState(
    objectId: string,
    newState: ProjectMappingState,
    acceptedBy: AcceptedBy | null,
    transitionedAt: string
  ): Promise<void> {
    const parsedObjectId = parseObjectId(objectId);
    const parsedState = parseProjectMappingState(newState);
    const parsedAcceptedBy = parseAcceptedBy(acceptedBy);
    const parsedTransitionedAt = parseTimestamp(transitionedAt);

    try {
      const result = this.updateStateStatement.run(
        parsedState,
        parsedAcceptedBy,
        parsedTransitionedAt,
        parsedTransitionedAt,
        parsedObjectId
      );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Project mapping anchor ${parsedObjectId} was not found.`);
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update project mapping anchor ${parsedObjectId}.`,
        error
      );
    }
  }

  public async listPending(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.listPendingStatement.all(parsedWorkspaceId) as ProjectMappingAnchorRow[];
      return rows.map((row) => parseProjectMappingAnchorRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list pending project mapping anchors for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }
}

function parseProjectMappingAnchor(value: ProjectMappingAnchorRecord): Readonly<ProjectMappingAnchorRecord> {
  try {
    return deepFreeze({
      object_id: parseObjectId(value.object_id),
      object_kind: parseObjectKind(value.object_kind),
      schema_version: parseSchemaVersion(value.schema_version),
      lifecycle_state: parseLifecycleState(value.lifecycle_state),
      created_at: parseTimestamp(value.created_at),
      updated_at: parseTimestamp(value.updated_at),
      created_by: parseCreatedBy(value.created_by),
      global_object_id: parseGlobalObjectId(value.global_object_id),
      project_id: parseProjectId(value.project_id),
      workspace_id: parseWorkspaceId(value.workspace_id),
      mapping_state: parseProjectMappingState(value.mapping_state),
      accepted_by: parseAcceptedBy(value.accepted_by),
      last_transition_at: parseTimestamp(value.last_transition_at)
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", "Failed to validate project mapping anchor.", error);
  }
}

function parseProjectMappingAnchorRow(row: ProjectMappingAnchorRow): Readonly<ProjectMappingAnchorRecord> {
  try {
    return deepFreeze({
      object_id: parseObjectId(row.object_id),
      object_kind: parseObjectKind(row.object_kind),
      schema_version: parseSchemaVersion(row.schema_version),
      lifecycle_state: parseLifecycleState(row.lifecycle_state),
      created_at: parseTimestamp(row.created_at),
      updated_at: parseTimestamp(row.updated_at),
      created_by: parseCreatedBy(row.created_by),
      global_object_id: parseGlobalObjectId(row.global_object_id),
      project_id: parseProjectId(row.project_id),
      workspace_id: parseWorkspaceId(row.workspace_id),
      mapping_state: parseProjectMappingState(row.mapping_state),
      accepted_by: parseAcceptedBy(row.accepted_by),
      last_transition_at: parseTimestamp(row.last_transition_at)
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("VALIDATION_FAILED", "Failed to validate project mapping anchor row.", error);
  }
}

function parseAcceptedBy(value: AcceptedBy | string | null): AcceptedBy | null {
  const parsedValue = parseNullableString(value, "accepted_by");

  if (parsedValue === null) {
    return null;
  }

  if (acceptedByValues.includes(parsedValue as AcceptedBy)) {
    return parsedValue as AcceptedBy;
  }

  throw new StorageError("VALIDATION_FAILED", "Failed to validate accepted_by.");
}

function parseProjectMappingState(value: ProjectMappingState | string): ProjectMappingState {
  try {
    return ProjectMappingStateSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate project mapping state.", error);
  }
}

function parseObjectKind(value: string): typeof ObjectKind.PROJECT_MAPPING_ANCHOR {
  const parsed = parseNonEmptyString(value, "object_kind");

  if (parsed !== ObjectKind.PROJECT_MAPPING_ANCHOR) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate object_kind.");
  }

  return ObjectKind.PROJECT_MAPPING_ANCHOR;
}

function parseSchemaVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate schema_version.");
  }

  return value;
}

const parseObjectId = (value: string): string => parseNonEmptyString(value, "object_id");
const parseCreatedBy = (value: string): string => parseNonEmptyString(value, "created_by");
const parseGlobalObjectId = (value: string): string => parseNonEmptyString(value, "global_object_id");
const parseProjectId = (value: string): string => parseNonEmptyString(value, "project_id");
const parseWorkspaceId = (value: string): string => parseNonEmptyString(value, "workspace_id");

function parseLifecycleState(value: string): ObjectLifecycleState {
  try {
    return ObjectLifecycleStateSchema.parse(parseNonEmptyString(value, "lifecycle_state"));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate lifecycle_state.", error);
  }
}
