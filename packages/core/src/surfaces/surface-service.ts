import { randomUUID } from "node:crypto";
import {
  SurfaceEventType,
  SoulSurfaceAnchorCreatedPayloadSchema,
  SoulSurfaceAnchorDeletedPayloadSchema,
  SoulSurfaceCreatedPayloadSchema,
  SoulSurfaceStatusChangedPayloadSchema,
  SurfaceAnchorKindSchema,
  SurfaceAnchorSchema,
  SurfaceIdentitySchema,
  SurfaceStatus,
  SurfaceStatusSchema,
  TransitionCausedBySchema,
  type EventLogEntry,
  type SurfaceAnchor,
  type SurfaceAnchorKind,
  type SurfaceIdentity,
  type SurfaceStatus as SurfaceStatusType,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";
import { isUniqueConstraintError } from "../shared/event-utils.js";
import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

import {
  SurfaceDriftCoordinator,
  type SurfaceDriftGovernancePort
} from "./surface-drift-coordinator.js";

const SURFACE_STATUS_TRANSITIONS: Readonly<Record<SurfaceStatusType, readonly SurfaceStatusType[]>> = {
  [SurfaceStatus.ACTIVE]: [SurfaceStatus.WEAKLY_BOUND, SurfaceStatus.ORPHANED, SurfaceStatus.REVOKED],
  [SurfaceStatus.WEAKLY_BOUND]: [SurfaceStatus.ACTIVE, SurfaceStatus.ORPHANED, SurfaceStatus.REVOKED],
  [SurfaceStatus.ORPHANED]: [SurfaceStatus.ACTIVE, SurfaceStatus.REVOKED],
  [SurfaceStatus.REVOKED]: []
};

type SurfaceEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface SurfaceServiceSurfaceIdentityRepoPort {
  create(identity: Readonly<SurfaceIdentity>): Promise<Readonly<SurfaceIdentity>>;
  createWithEvent(
    identity: Readonly<SurfaceIdentity>,
    event: SurfaceEventDraft
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>>;
  findById(objectId: string): Promise<Readonly<SurfaceIdentity> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]>;
  updateStatus(
    objectId: string,
    surfaceStatus: SurfaceStatusType,
    updatedAt: string
  ): Promise<Readonly<SurfaceIdentity>>;
  updateStatusWithEvent(
    objectId: string,
    surfaceStatus: SurfaceStatusType,
    updatedAt: string,
    event: SurfaceEventDraft
  ): Promise<Readonly<{ identity: Readonly<SurfaceIdentity>; event: EventLogEntry }>>;
}

export interface SurfaceServiceSurfaceAnchorRepoPort {
  create(anchor: Readonly<SurfaceAnchor>): Promise<Readonly<SurfaceAnchor>>;
  createWithEvent(
    anchor: Readonly<SurfaceAnchor>,
    event: SurfaceEventDraft
  ): Promise<Readonly<{ anchor: Readonly<SurfaceAnchor>; event: EventLogEntry }>>;
  findById(objectId: string): Promise<Readonly<SurfaceAnchor> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]>;
  delete(objectId: string): Promise<void>;
  deleteWithEvent(
    objectId: string,
    event: SurfaceEventDraft
  ): Promise<Readonly<EventLogEntry>>;
}

export interface SurfaceRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SurfaceServiceDependencies {
  readonly surfaceIdentityRepo: SurfaceServiceSurfaceIdentityRepoPort;
  readonly surfaceAnchorRepo: SurfaceServiceSurfaceAnchorRepoPort;
  readonly runtimeNotifier: SurfaceRuntimeNotifierPort;
  readonly surfaceDriftService?: SurfaceDriftGovernancePort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly surfaceBindingCascader?: {
    cascadeDetachBySurfaceId(surfaceId: string, workspaceId: string): Promise<void>;
  };
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

function parseCreateSurfaceInput(input: {
  readonly surface_id: string;
  readonly surface_kind: string;
  readonly workspace_id: string;
  readonly created_by: string;
}) {
  return {
    surface_id: parseNonEmptyString(input.surface_id, "surface_id"),
    surface_kind: parseNonEmptyString(input.surface_kind, "surface_kind"),
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
    created_by: parseNonEmptyString(input.created_by, "created_by")
  };
}

function parseAddAnchorInput(input: {
  readonly surface_id: string;
  readonly anchor_kind: SurfaceAnchorKind;
  readonly anchor_value: string;
  readonly workspace_id: string;
  readonly created_by: string;
}) {
  return {
    surface_id: parseNonEmptyString(input.surface_id, "surface_id"),
    anchor_kind: parseSurfaceAnchorKind(input.anchor_kind),
    anchor_value: parseNonEmptyString(input.anchor_value, "anchor_value"),
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
    created_by: parseNonEmptyString(input.created_by, "created_by")
  };
}

function parseSurfaceIdentity(value: SurfaceIdentity): SurfaceIdentity {
  try {
    return SurfaceIdentitySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface identity payload", { cause: error });
  }
}

function parseSurfaceAnchor(value: SurfaceAnchor): SurfaceAnchor {
  try {
    return SurfaceAnchorSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface anchor payload", { cause: error });
  }
}

function parseSurfaceStatus(value: SurfaceStatusType): SurfaceStatusType {
  try {
    return SurfaceStatusSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface status", { cause: error });
  }
}

function parseSurfaceAnchorKind(value: SurfaceAnchorKind): SurfaceAnchorKind {
  try {
    return SurfaceAnchorKindSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface anchor kind", { cause: error });
  }
}

function parseTransitionCausedBy(value: TransitionCausedBy): TransitionCausedBy {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid caused_by", { cause: error });
  }
}

function parseReason(value: string): string {
  return parseNonEmptyString(value, "reason");
}

function ensureValidStatusTransition(from: SurfaceStatusType, to: SurfaceStatusType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Surface status transition must change state");
  }

  if (!SURFACE_STATUS_TRANSITIONS[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid surface status transition: ${from} -> ${to}`);
  }
}

export class SurfaceService {
  public readonly generateObjectId: () => string;

  public readonly now: () => string;

  public readonly warn: (message: string, meta: Record<string, unknown>) => void;

  private readonly driftCoordinator: SurfaceDriftCoordinator;

  public constructor(public readonly dependencies: SurfaceServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => {});
    this.driftCoordinator = new SurfaceDriftCoordinator({
      surfaceDriftService: dependencies.surfaceDriftService,
      warn: this.warn
    });
  }

  public async createSurface(input: {
    readonly surface_id: string;
    readonly surface_kind: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceIdentity>> {
    const parsedInput = parseCreateSurfaceInput(input);
    const existing = await this.dependencies.surfaceIdentityRepo.findBySurfaceId(
      parsedInput.surface_id,
      parsedInput.workspace_id
    );

    if (existing !== null) {
      throw new CoreError("CONFLICT", "surface_id already exists in workspace");
    }

    const timestamp = this.now();
    const identity = parseSurfaceIdentity({
      object_id: this.generateObjectId(),
      object_kind: "surface_identity",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: parsedInput.created_by,
      surface_id: parsedInput.surface_id,
      surface_kind: parsedInput.surface_kind,
      surface_status: SurfaceStatus.ACTIVE,
      workspace_id: parsedInput.workspace_id
    });

    const event: SurfaceEventDraft = {
      event_type: SurfaceEventType.SOUL_SURFACE_CREATED,
      entity_type: "surface_identity",
      entity_id: identity.object_id,
      workspace_id: identity.workspace_id,
      run_id: null,
      caused_by: identity.created_by,
      payload_json: SoulSurfaceCreatedPayloadSchema.parse({
        object_id: identity.object_id,
        object_kind: identity.object_kind,
        workspace_id: identity.workspace_id,
        run_id: null,
        surface_id: identity.surface_id,
        surface_kind: identity.surface_kind,
        surface_status: identity.surface_status
      })
    };

    try {
      const created = await this.dependencies.surfaceIdentityRepo.createWithEvent(identity, event);
      await this.dependencies.runtimeNotifier.notifyEntry(created.event);
      return created.identity;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CoreError("CONFLICT", "surface_id already exists in workspace", { cause: error });
      }

      throw error;
    }
  }

  public async findById(objectId: string): Promise<Readonly<SurfaceIdentity>> {
    const parsedObjectId = parseObjectId(objectId, "surface object_id");
    const identity = await this.dependencies.surfaceIdentityRepo.findById(parsedObjectId);

    if (identity === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    return identity;
  }

  public async findBySurfaceId(surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface_id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    return await this.dependencies.surfaceIdentityRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    return await this.dependencies.surfaceIdentityRepo.findByWorkspace(parsedWorkspaceId);
  }

  public async transitionStatus(objectId: string, newStatus: SurfaceStatusType, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<SurfaceIdentity>> {
    const parsedObjectId = parseObjectId(objectId, "surface object_id");
    const parsedStatus = parseSurfaceStatus(newStatus);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await this.dependencies.surfaceIdentityRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    ensureValidStatusTransition(existing.surface_status, parsedStatus);
    const driftLeaseId = await this.driftCoordinator.acquireLease(
      existing.workspace_id,
      "surface.transition_status",
      parsedCausedBy
    );

    try {
      const occurredAt = this.now();
      const event: SurfaceEventDraft = {
        event_type: SurfaceEventType.SOUL_SURFACE_STATUS_CHANGED,
        entity_type: "surface_identity",
        entity_id: existing.object_id,
        workspace_id: existing.workspace_id,
        run_id: null,
        caused_by: parsedCausedBy,
        payload_json: SoulSurfaceStatusChangedPayloadSchema.parse({
          object_id: existing.object_id,
          object_kind: existing.object_kind,
          workspace_id: existing.workspace_id,
          run_id: null,
          surface_id: existing.surface_id,
          from_status: existing.surface_status,
          to_status: parsedStatus,
          reason_code: parsedReason,
          caused_by: parsedCausedBy,
          occurred_at: occurredAt
        })
      };

      const updated = await this.dependencies.surfaceIdentityRepo.updateStatusWithEvent(
        existing.object_id,
        parsedStatus,
        occurredAt,
        event
      );

      await this.dependencies.runtimeNotifier.notifyEntry(updated.event);

      if (
        parsedStatus === SurfaceStatus.REVOKED &&
        this.dependencies.surfaceBindingCascader !== undefined
      ) {
        await this.dependencies.surfaceBindingCascader.cascadeDetachBySurfaceId(
          updated.identity.surface_id,
          updated.identity.workspace_id
        );
      }

      await this.driftCoordinator.classifyStatusDriftSafely({
        workspaceId: existing.workspace_id,
        operationType: "surface.transition_status",
        surfaceId: existing.surface_id,
        fromStatus: existing.surface_status,
        toStatus: parsedStatus,
        driftType: parsedStatus === SurfaceStatus.REVOKED ? "policy_override" : "scope_change"
      });
      return updated.identity;
    } finally {
      await this.driftCoordinator.releaseLeaseSafely({
        leaseId: driftLeaseId,
        workspaceId: existing.workspace_id,
        operationType: "surface.transition_status",
        releasedBy: parsedCausedBy
      });
    }
  }

  public async addAnchor(input: {
    readonly surface_id: string;
    readonly anchor_kind: SurfaceAnchorKind;
    readonly anchor_value: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceAnchor>> {
    const parsedInput = parseAddAnchorInput(input);
    const surface = await this.dependencies.surfaceIdentityRepo.findBySurfaceId(
      parsedInput.surface_id,
      parsedInput.workspace_id
    );

    if (surface === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    const timestamp = this.now();
    const anchor = parseSurfaceAnchor({
      object_id: this.generateObjectId(),
      object_kind: "surface_anchor",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: parsedInput.created_by,
      surface_id: parsedInput.surface_id,
      anchor_kind: parsedInput.anchor_kind,
      anchor_value: parsedInput.anchor_value,
      workspace_id: parsedInput.workspace_id
    });

    const event: SurfaceEventDraft = {
      event_type: SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED,
      entity_type: "surface_anchor",
      entity_id: anchor.object_id,
      workspace_id: anchor.workspace_id,
      run_id: null,
      caused_by: anchor.created_by,
      payload_json: SoulSurfaceAnchorCreatedPayloadSchema.parse({
        object_id: anchor.object_id,
        object_kind: anchor.object_kind,
        workspace_id: anchor.workspace_id,
        run_id: null,
        surface_id: anchor.surface_id,
        anchor_kind: anchor.anchor_kind,
        anchor_value: anchor.anchor_value
      })
    };

    const created = await this.dependencies.surfaceAnchorRepo.createWithEvent(anchor, event);
    await this.dependencies.runtimeNotifier.notifyEntry(created.event);

    return created.anchor;
  }

  public async removeAnchor(anchorId: string, causedBy: string): Promise<void> {
    const parsedAnchorId = parseObjectId(anchorId, "anchor object_id");
    const parsedCausedBy = parseNonEmptyString(causedBy, "caused_by");
    const existing = await this.dependencies.surfaceAnchorRepo.findById(parsedAnchorId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Surface anchor not found");
    }

    const event: SurfaceEventDraft = {
      event_type: SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED,
      entity_type: "surface_anchor",
      entity_id: existing.object_id,
      workspace_id: existing.workspace_id,
      run_id: null,
      caused_by: parsedCausedBy,
      payload_json: SoulSurfaceAnchorDeletedPayloadSchema.parse({
        anchor_id: existing.object_id,
        surface_id: existing.surface_id,
        workspace_id: existing.workspace_id
      })
    };

    const deletedEvent = await this.dependencies.surfaceAnchorRepo.deleteWithEvent(parsedAnchorId, event);
    await this.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
  }

  public async listAnchors(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface_id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    const surface = await this.dependencies.surfaceIdentityRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);

    if (surface === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    return await this.dependencies.surfaceAnchorRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);
  }
}
