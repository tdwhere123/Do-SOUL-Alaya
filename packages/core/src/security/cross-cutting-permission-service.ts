import { randomUUID } from "node:crypto";
import {
  CrossCuttingPermissionSchema,
  CrossCuttingState,
  CrossCuttingStateSchema,
  SurfaceEventType,
  SoulCrossCuttingStateChangedPayloadSchema,
  type CrossCuttingPermission,
  type CrossCuttingState as CrossCuttingStateType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import { isUniqueConstraintError } from "../shared/event-utils.js";
import { parseSurfaceUri } from "../shared/surface-uri.js";
import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

const CROSS_CUTTING_STATE_TRANSITIONS: Readonly<
  Record<CrossCuttingStateType, readonly CrossCuttingStateType[]>
> = {
  [CrossCuttingState.NONE]: [CrossCuttingState.CANDIDATE],
  [CrossCuttingState.CANDIDATE]: [CrossCuttingState.ACTIVE, CrossCuttingState.REVOKED],
  [CrossCuttingState.ACTIVE]: [CrossCuttingState.REVOKED],
  [CrossCuttingState.REVOKED]: []
};

type CrossCuttingEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface CrossCuttingPermissionRecordView {
  readonly permission_id: string;
  readonly permission: Readonly<CrossCuttingPermission>;
}

export interface CrossCuttingPermissionServiceRepoPort {
  create(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView>>;
  createWithEvent(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string,
    event: CrossCuttingEventDraft
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecordView>; event: EventLogEntry }>>;
  findByPermissionId(permissionId: string): Promise<Readonly<CrossCuttingPermissionRecordView> | null>;
  findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<CrossCuttingPermissionRecordView>[]>;
  updateState(
    permissionId: string,
    crossCuttingState: CrossCuttingStateType,
    allowedSurfaces: readonly string[],
    updatedAt: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView>>;
  updateStateWithEvent(
    permissionId: string,
    crossCuttingState: CrossCuttingStateType,
    allowedSurfaces: readonly string[],
    updatedAt: string,
    event: CrossCuttingEventDraft
  ): Promise<Readonly<{ record: Readonly<CrossCuttingPermissionRecordView>; event: EventLogEntry }>>;
}

export interface CrossCuttingPermissionRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface CrossCuttingPermissionServiceDependencies {
  readonly crossCuttingRepo: CrossCuttingPermissionServiceRepoPort;
  readonly runtimeNotifier: CrossCuttingPermissionRuntimeNotifier;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class CrossCuttingPermissionService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: CrossCuttingPermissionServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async createCrossCuttingPermission(input: {
    readonly object_id: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<CrossCuttingPermissionRecordView>> {
    const parsedInput = parseCreateCrossCuttingInput(input);
    await this.ensurePermissionDoesNotExist(parsedInput.object_id, parsedInput.workspace_id);

    const permissionId = this.generateObjectId();
    const timestamp = this.now();
    const permission = this.buildPermission(parsedInput, timestamp);
    const event = this.buildStateChangedEvent({
      permissionId,
      permission,
      fromState: null,
      toState: CrossCuttingState.NONE,
      allowedSurfaces: [],
      reason: "initialized",
      occurredAt: timestamp,
      causedBy: permission.created_by
    });

    return await this.persistPermissionAndBroadcast(permission, permissionId, event);
  }

  public async findByPermissionId(
    permissionId: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView> | null> {
    return await this.dependencies.crossCuttingRepo.findByPermissionId(parseObjectId(permissionId, "permission_id"));
  }

  public async transitionCrossCuttingState(
    permissionId: string,
    newState: CrossCuttingStateType,
    allowedSurfaces: readonly string[],
    reason: string,
    causedBy: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView>> {
    const parsedPermissionId = parseObjectId(permissionId, "permission_id");
    const parsedNewState = parseCrossCuttingState(newState);
    const parsedAllowedSurfaces = parseAllowedSurfaces(allowedSurfaces);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseCausedBy(causedBy);

    const existing = await this.dependencies.crossCuttingRepo.findByPermissionId(parsedPermissionId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Cross cutting permission not found");
    }

    ensureValidCrossCuttingTransition(existing.permission.cross_cutting_state, parsedNewState);

    const nextAllowedSurfaces = parsedNewState === CrossCuttingState.ACTIVE ? parsedAllowedSurfaces : [];

    if (parsedNewState === CrossCuttingState.ACTIVE && nextAllowedSurfaces.length === 0) {
      throw new CoreError(
        "VALIDATION",
        "allowed_surfaces must be non-empty when cross_cutting_state transitions to active"
      );
    }

    const occurredAt = this.now();
    const event = this.buildStateChangedEvent({
      permissionId: existing.permission_id,
      permission: existing.permission,
      fromState: existing.permission.cross_cutting_state,
      toState: parsedNewState,
      allowedSurfaces: nextAllowedSurfaces,
      reason: parsedReason,
      occurredAt,
      causedBy: parsedCausedBy
    });

    const updated = await this.dependencies.crossCuttingRepo.updateStateWithEvent(
      existing.permission_id,
      parsedNewState,
      nextAllowedSurfaces,
      occurredAt,
      event
    );

    await this.dependencies.runtimeNotifier.notifyEntry(updated.event);

    return updated.record;
  }

  public async findCrossCuttingByObject(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<CrossCuttingPermissionRecordView> | null> {
    return await this.dependencies.crossCuttingRepo.findByObjectId(
      parseNonEmptyString(objectId, "object_id"),
      parseNonEmptyString(workspaceId, "workspace_id")
    );
  }

  public async findCrossCuttingByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<CrossCuttingPermissionRecordView>[]> {
    return await this.dependencies.crossCuttingRepo.findByWorkspace(
      parseNonEmptyString(workspaceId, "workspace_id")
    );
  }

  private buildStateChangedEvent(input: {
    readonly permissionId: string;
    readonly permission: Readonly<CrossCuttingPermission>;
    readonly fromState: CrossCuttingStateType | null;
    readonly toState: CrossCuttingStateType;
    readonly allowedSurfaces: readonly string[];
    readonly reason: string;
    readonly occurredAt: string;
    readonly causedBy: string;
  }): CrossCuttingEventDraft {
    return {
      event_type: SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
      entity_type: "cross_cutting_permission",
      entity_id: input.permissionId,
      workspace_id: input.permission.workspace_id,
      run_id: null,
      caused_by: input.causedBy,
      payload_json: SoulCrossCuttingStateChangedPayloadSchema.parse({
        permission_id: input.permissionId,
        object_id: input.permission.object_id,
        from_state: input.fromState,
        to_state: input.toState,
        allowed_surfaces: input.allowedSurfaces,
        reason: input.reason,
        occurred_at: input.occurredAt,
        workspace_id: input.permission.workspace_id
      })
    };
  }

  private async ensurePermissionDoesNotExist(objectId: string, workspaceId: string): Promise<void> {
    const existing = await this.dependencies.crossCuttingRepo.findByObjectId(objectId, workspaceId);

    if (existing !== null) {
      throw new CoreError("CONFLICT", "cross_cutting permission already exists for object");
    }
  }

  private buildPermission(
    input: ReturnType<typeof parseCreateCrossCuttingInput>,
    timestamp: string
  ): Readonly<CrossCuttingPermission> {
    return parseCrossCuttingPermission({
      object_id: input.object_id,
      object_kind: "cross_cutting_permission",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: input.created_by,
      cross_cutting_state: CrossCuttingState.NONE,
      allowed_surfaces: [],
      workspace_id: input.workspace_id
    });
  }

  private async persistPermissionAndBroadcast(
    permission: Readonly<CrossCuttingPermission>,
    permissionId: string,
    event: CrossCuttingEventDraft
  ): Promise<Readonly<CrossCuttingPermissionRecordView>> {
    try {
      const created = await this.dependencies.crossCuttingRepo.createWithEvent(permission, permissionId, event);
      await this.dependencies.runtimeNotifier.notifyEntry(created.event);
      return created.record;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CoreError("CONFLICT", "cross_cutting permission already exists for object", {
          cause: error
        });
      }

      throw error;
    }
  }
}

function parseCreateCrossCuttingInput(input: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly created_by: string;
}) {
  return {
    object_id: parseNonEmptyString(input.object_id, "object_id"),
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
    created_by: parseNonEmptyString(input.created_by, "created_by")
  };
}

function parseCrossCuttingState(value: CrossCuttingStateType): CrossCuttingStateType {
  try {
    return CrossCuttingStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid cross_cutting_state", { cause: error });
  }
}

function parseAllowedSurfaces(value: readonly string[]): readonly string[] {
  const unique = new Set<string>();

  for (const surfaceId of value) {
    unique.add(parseSurfaceUri(surfaceId, "allowed_surfaces"));
  }

  return [...unique];
}

function parseCrossCuttingPermission(value: CrossCuttingPermission): CrossCuttingPermission {
  try {
    return CrossCuttingPermissionSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid cross cutting permission payload", { cause: error });
  }
}

function parseReason(value: string): string {
  return parseNonEmptyString(value, "reason");
}

function parseCausedBy(value: string): string {
  return parseNonEmptyString(value, "caused_by");
}

function ensureValidCrossCuttingTransition(from: CrossCuttingStateType, to: CrossCuttingStateType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "cross_cutting state transition must change state");
  }

  if (!CROSS_CUTTING_STATE_TRANSITIONS[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid cross_cutting transition: ${from} -> ${to}`);
  }
}
