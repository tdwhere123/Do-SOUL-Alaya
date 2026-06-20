import { randomUUID } from "node:crypto";
import {
  canonicalGovernanceSubject,
  SurfaceStatus,
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

import { surfaceServiceCreateSurface, surfaceServiceFindById, surfaceServiceFindBySurfaceId, surfaceServiceFindByWorkspace, surfaceServiceTransitionStatus, surfaceServiceAddAnchor, surfaceServiceRemoveAnchor } from "./surface-service-methods-1.js";
import { surfaceServiceListAnchors, surfaceServiceAcquireSurfaceDriftLease, surfaceServiceReleaseSurfaceDriftLeaseSafely, surfaceServiceClassifySurfaceStatusDriftSafely, surfaceServiceClassifySurfaceStatusDrift } from "./surface-service-methods-2.js";

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

export class SurfaceService {
public readonly generateObjectId: () => string;

public readonly now: () => string;

public readonly warn: (message: string, meta: Record<string, unknown>) => void;

public constructor(public readonly dependencies: SurfaceServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => {});
  }

  public async createSurface(input: {
    readonly surface_id: string;
    readonly surface_kind: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceIdentity>> {
    return surfaceServiceCreateSurface(this, input);
  }

  public async findById(objectId: string): Promise<Readonly<SurfaceIdentity>> {
    return surfaceServiceFindById(this, objectId);
  }

  public async findBySurfaceId(surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null> {
    return surfaceServiceFindBySurfaceId(this, surfaceId, workspaceId);
  }

  public async findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceIdentity>[]> {
    return surfaceServiceFindByWorkspace(this, workspaceId);
  }

  public async transitionStatus(objectId: string, newStatus: SurfaceStatusType, reason: string, causedBy: TransitionCausedBy): Promise<Readonly<SurfaceIdentity>> {
    return surfaceServiceTransitionStatus(this, objectId, newStatus, reason, causedBy);
  }

  public async addAnchor(input: {
    readonly surface_id: string;
    readonly anchor_kind: SurfaceAnchorKind;
    readonly anchor_value: string;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceAnchor>> {
    return surfaceServiceAddAnchor(this, input);
  }

  public async removeAnchor(anchorId: string, causedBy: string): Promise<void> {
    return surfaceServiceRemoveAnchor(this, anchorId, causedBy);
  }

  public async listAnchors(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceAnchor>[]> {
    return surfaceServiceListAnchors(this, surfaceId, workspaceId);
  }

  private async acquireSurfaceDriftLease(workspaceId: string, operationType: SurfaceDriftOperationType, grantedTo: string): Promise<string | null> {
    return surfaceServiceAcquireSurfaceDriftLease(this, workspaceId, operationType, grantedTo);
  }

  private async releaseSurfaceDriftLeaseSafely(params: {
    readonly leaseId: string | null;
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly releasedBy: string;
    readonly failureMessage: string;
    readonly propagateFailure: boolean;
  }): Promise<void> {
    return surfaceServiceReleaseSurfaceDriftLeaseSafely(this, params);
  }

  private async classifySurfaceStatusDriftSafely(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
  }): Promise<void> {
    return surfaceServiceClassifySurfaceStatusDriftSafely(this, params);
  }

  private async classifySurfaceStatusDrift(params: {
    readonly workspaceId: string;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
  }): Promise<void> {
    return surfaceServiceClassifySurfaceStatusDrift(this, params);
  }
}
