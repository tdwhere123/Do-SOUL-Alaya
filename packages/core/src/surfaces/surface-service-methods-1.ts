
import {
  canonicalGovernanceSubject,
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
  type DriftType,
  type EventLogEntry,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType,
  type SurfaceAnchor,
  type SurfaceAnchorKind,
  type SurfaceIdentity,
  type SurfaceStatus as SurfaceStatusType,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import { isUniqueConstraintError } from "../shared/event-utils.js";

import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

type SurfaceServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
  dependencies: SurfaceServiceDependencies;
  [key: string]: any;
};


const SURFACE_STATUS_TRANSITIONS: Readonly<Record<SurfaceStatusType, readonly SurfaceStatusType[]>> = {
  [SurfaceStatus.ACTIVE]: [SurfaceStatus.WEAKLY_BOUND, SurfaceStatus.ORPHANED, SurfaceStatus.REVOKED],
  [SurfaceStatus.WEAKLY_BOUND]: [SurfaceStatus.ACTIVE, SurfaceStatus.ORPHANED, SurfaceStatus.REVOKED],
  [SurfaceStatus.ORPHANED]: [SurfaceStatus.ACTIVE, SurfaceStatus.REVOKED],
  [SurfaceStatus.REVOKED]: []
};

const SURFACE_STATUS_GOVERNANCE_SUBJECT = canonicalGovernanceSubject("surface_governance", {
  entity: "status"
}).canonical_key;

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

interface SurfaceDriftGovernancePort {
  acquireLease(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly grantedTo: string;
    readonly ttlMs: number;
    readonly driftId?: string | null;
  }): Promise<Readonly<GovernanceDriftLease>>;
  releaseLease(leaseId: string, workspaceId: string, releasedBy: string): Promise<void>;
  classifyDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly affectedSubject: string;
    readonly description: string;
  }): Promise<Readonly<DriftClassification>>;
  alertOnCriticalDrift(
    classification: Readonly<DriftClassification>
  ): Promise<Readonly<DriftAlert> | null>;
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

export async function surfaceServiceCreateSurface(owner: SurfaceServiceMethodOwner, input: {
    readonly surface_id: string;
    readonly surface_kind: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceIdentity>> {
    const parsedInput = parseCreateSurfaceInput(input);
    const existing = await owner.dependencies.surfaceIdentityRepo.findBySurfaceId(
      parsedInput.surface_id,
      parsedInput.workspace_id
    );

    if (existing !== null) {
      throw new CoreError("CONFLICT", "surface_id already exists in workspace");
    }

    const timestamp = owner.now();
    const identity = parseSurfaceIdentity({
      object_id: owner.generateObjectId(),
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
      const created = await owner.dependencies.surfaceIdentityRepo.createWithEvent(identity, event);
      await owner.dependencies.runtimeNotifier.notifyEntry(created.event);
      return created.identity;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CoreError("CONFLICT", "surface_id already exists in workspace", { cause: error });
      }

      throw error;
    }
  }

export async function surfaceServiceFindById(owner: SurfaceServiceMethodOwner, objectId: string): Promise<Readonly<SurfaceIdentity>> {
    const parsedObjectId = parseObjectId(objectId, "surface object_id");
    const identity = await owner.dependencies.surfaceIdentityRepo.findById(parsedObjectId);

    if (identity === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    return identity;
  }

export async function surfaceServiceFindBySurfaceId(owner: SurfaceServiceMethodOwner, surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface_id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    return await owner.dependencies.surfaceIdentityRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);
  }

export async function surfaceServiceFindByWorkspace(owner: SurfaceServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");
    return await owner.dependencies.surfaceIdentityRepo.findByWorkspace(parsedWorkspaceId);
  }

export async function surfaceServiceTransitionStatus(owner: SurfaceServiceMethodOwner, objectId: string, newStatus: SurfaceStatusType, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<SurfaceIdentity>> {
    const parsedObjectId = parseObjectId(objectId, "surface object_id");
    const parsedStatus = parseSurfaceStatus(newStatus);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseTransitionCausedBy(causedBy);

    const existing = await owner.dependencies.surfaceIdentityRepo.findById(parsedObjectId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    ensureValidStatusTransition(existing.surface_status, parsedStatus);
    const driftLeaseId = await owner.acquireSurfaceDriftLease(
      existing.workspace_id,
      "surface.transition_status",
      parsedCausedBy
    );
    let operationCompleted = false;

    try {
      const occurredAt = owner.now();
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

      const updated = await owner.dependencies.surfaceIdentityRepo.updateStatusWithEvent(
        existing.object_id,
        parsedStatus,
        occurredAt,
        event
      );
      operationCompleted = true;

      await owner.dependencies.runtimeNotifier.notifyEntry(updated.event);

      if (
        parsedStatus === SurfaceStatus.REVOKED &&
        owner.dependencies.surfaceBindingCascader !== undefined
      ) {
        await owner.dependencies.surfaceBindingCascader.cascadeDetachBySurfaceId(
          updated.identity.surface_id,
          updated.identity.workspace_id
        );
      }

      await owner.classifySurfaceStatusDriftSafely({
        workspaceId: existing.workspace_id,
        operationType: "surface.transition_status",
        surfaceId: existing.surface_id,
        fromStatus: existing.surface_status,
        toStatus: parsedStatus
      });
      return updated.identity;
    } finally {
      await owner.releaseSurfaceDriftLeaseSafely({
        leaseId: driftLeaseId,
        workspaceId: existing.workspace_id,
        operationType: "surface.transition_status",
        releasedBy: parsedCausedBy,
        failureMessage: "Surface status transition applied but drift lease release failed.",
        propagateFailure: operationCompleted
      });
    }
  }

export async function surfaceServiceAddAnchor(owner: SurfaceServiceMethodOwner, input: {
    readonly surface_id: string;
    readonly anchor_kind: SurfaceAnchorKind;
    readonly anchor_value: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceAnchor>> {
    const parsedInput = parseAddAnchorInput(input);
    const surface = await owner.dependencies.surfaceIdentityRepo.findBySurfaceId(
      parsedInput.surface_id,
      parsedInput.workspace_id
    );

    if (surface === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    const timestamp = owner.now();
    const anchor = parseSurfaceAnchor({
      object_id: owner.generateObjectId(),
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

    const created = await owner.dependencies.surfaceAnchorRepo.createWithEvent(anchor, event);
    await owner.dependencies.runtimeNotifier.notifyEntry(created.event);

    return created.anchor;
  }

export async function surfaceServiceRemoveAnchor(owner: SurfaceServiceMethodOwner, anchorId: string, causedBy: string): Promise<void> {
    const parsedAnchorId = parseObjectId(anchorId, "anchor object_id");
    const parsedCausedBy = parseNonEmptyString(causedBy, "caused_by");
    const existing = await owner.dependencies.surfaceAnchorRepo.findById(parsedAnchorId);

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

    const deletedEvent = await owner.dependencies.surfaceAnchorRepo.deleteWithEvent(parsedAnchorId, event);
    await owner.dependencies.runtimeNotifier.notifyEntry(deletedEvent);
  }
