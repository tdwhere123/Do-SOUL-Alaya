import { randomUUID } from "node:crypto";

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

import { DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS } from "./surface-drift-service.js";
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

export async function surfaceServiceListAnchors(owner: SurfaceServiceMethodOwner, surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface_id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    const surface = await owner.dependencies.surfaceIdentityRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);

    if (surface === null) {
      throw new CoreError("NOT_FOUND", "Surface identity not found");
    }

    return await owner.dependencies.surfaceAnchorRepo.findBySurfaceId(parsedSurfaceId, parsedWorkspaceId);
  }

export async function surfaceServiceAcquireSurfaceDriftLease(owner: SurfaceServiceMethodOwner, workspaceId: string, operationType: SurfaceDriftOperationType, grantedTo: string): Promise<string | null> {
    const driftService = owner.dependencies.surfaceDriftService;

    if (driftService === undefined) {
      return null;
    }

    const lease = await driftService.acquireLease({
      workspaceId,
      operationType,
      grantedTo,
      ttlMs: DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS
    });

    return lease.lease_id;
  }

export async function surfaceServiceReleaseSurfaceDriftLeaseSafely(owner: SurfaceServiceMethodOwner, params: {
    readonly leaseId: string | null;
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly releasedBy: string;
    readonly failureMessage: string;
    readonly propagateFailure: boolean;
  }): Promise<void> {
    if (params.leaseId === null || owner.dependencies.surfaceDriftService === undefined) {
      return;
    }

    try {
      await owner.dependencies.surfaceDriftService.releaseLease(
        params.leaseId,
        params.workspaceId,
        params.releasedBy
      );
    } catch (error) {
      owner.warn("Surface drift lease release failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        leaseId: params.leaseId,
        error
      });
    }
  }

export async function surfaceServiceClassifySurfaceStatusDriftSafely(owner: SurfaceServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
  }): Promise<void> {
    try {
      await owner.classifySurfaceStatusDrift(params);
    } catch (error) {
      owner.warn("Surface drift telemetry failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        surfaceId: params.surfaceId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        error
      });
    }
  }

export async function surfaceServiceClassifySurfaceStatusDrift(owner: SurfaceServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
  }): Promise<void> {
    const driftService = owner.dependencies.surfaceDriftService;

    if (driftService === undefined) {
      return;
    }

    const driftType = params.toStatus === SurfaceStatus.REVOKED ? "policy_override" : "scope_change";
    const classification = await driftService.classifyDrift({
      workspaceId: params.workspaceId,
      driftType,
      affectedSubject: SURFACE_STATUS_GOVERNANCE_SUBJECT,
      description: `Surface ${params.surfaceId} status changed from ${params.fromStatus} to ${params.toStatus}`
    });

    await driftService.alertOnCriticalDrift(classification);
  }
