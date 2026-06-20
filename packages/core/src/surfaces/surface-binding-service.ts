import { randomUUID } from "node:crypto";
import {
  BindingState,
  canonicalGovernanceSubject,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  type BindingState as BindingStateType,
  type CrossCuttingPermission,
  type EventLogEntry,
  type SurfaceDriftOperationType,
  type SurfaceBinding
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";

import { surfaceBindingServiceBindObject, surfaceBindingServiceFindBindingById, surfaceBindingServiceTransitionBindingState, surfaceBindingServiceCascadeDetachBySurfaceId, surfaceBindingServiceFindBindingsByObject, surfaceBindingServiceFindBindingsBySurface, surfaceBindingServiceFindBindingsByWorkspace, surfaceBindingServiceEnsurePrimaryBindingAllowed, surfaceBindingServiceEnsureCrossCuttingAllowsBinding, surfaceBindingServiceBuildBinding, surfaceBindingServiceBuildBindingCreatedEvent, surfaceBindingServicePersistBindingWithEvent, surfaceBindingServiceAcquireDriftLease } from "./surface-binding-service-methods-1.js";
import { surfaceBindingServiceReleaseDriftLeaseSafely, surfaceBindingServiceClassifyBindingDriftSafely, surfaceBindingServiceClassifyBindingDrift, surfaceBindingServiceRequireEventPublisher } from "./surface-binding-service-methods-2.js";

const BINDING_STATE_TRANSITIONS: Readonly<Record<BindingStateType, readonly BindingStateType[]>> = {
  [BindingState.ACTIVE]: [BindingState.STALE, BindingState.DETACHED],
  [BindingState.STALE]: [BindingState.ACTIVE, BindingState.DETACHED],
  [BindingState.DETACHED]: []
};

const SURFACE_BINDING_GOVERNANCE_SUBJECT = canonicalGovernanceSubject("surface_governance", {
  entity: "binding"
}).canonical_key;

type SurfaceBindingEventDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface SurfaceBindingRecordView {
  readonly binding_id: string;
  readonly binding: Readonly<SurfaceBinding>;
}

export interface SurfaceBindingServiceCrossCuttingPermissionLookupRecord {
  readonly permission_id: string;
  readonly permission: Readonly<CrossCuttingPermission>;
}

export interface SurfaceBindingServiceSurfaceBindingRepoPort {
  create(binding: Readonly<SurfaceBinding>, bindingId: string): Readonly<SurfaceBindingRecordView>;
  findByBindingId(bindingId: string): Promise<Readonly<SurfaceBindingRecordView> | null>;
  findByObjectId(objectId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findPrimaryBinding(objectId: string, workspaceId: string): Promise<Readonly<SurfaceBindingRecordView> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findDetachableBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  updateState(
    bindingId: string,
    bindingState: BindingStateType,
    updatedAt: string
  ): Readonly<SurfaceBindingRecordView>;
  cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): readonly Readonly<SurfaceBindingRecordView>[];
}

export interface SurfaceBindingServiceCrossCuttingLookupPort {
  findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<SurfaceBindingServiceCrossCuttingPermissionLookupRecord> | null>;
}

export interface SurfaceBindingEventPublisherPort
  extends Pick<EventPublisher, "appendManyWithMutation"> {}

export interface SurfaceBindingServiceDependencies {
  readonly surfaceBindingRepo: SurfaceBindingServiceSurfaceBindingRepoPort;
  readonly crossCuttingPermissionLookup: SurfaceBindingServiceCrossCuttingLookupPort;
  readonly eventPublisher: SurfaceBindingEventPublisherPort;
  readonly surfaceDriftService?: SurfaceBindingDriftGovernancePort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

interface SurfaceBindingDriftGovernancePort {
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

export class SurfaceBindingService {
public readonly generateObjectId: () => string;

public readonly now: () => string;

public readonly warn: (message: string, meta: Record<string, unknown>) => void;

public constructor(public readonly dependencies: SurfaceBindingServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => {});
  }

  public async bindObject(input: {
    readonly object_id: string;
    readonly surface_id: string;
    readonly is_primary: boolean;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceBindingRecordView>> {
    return surfaceBindingServiceBindObject(this, input);
  }

  public async findBindingById(bindingId: string): Promise<Readonly<SurfaceBindingRecordView> | null> {
    return surfaceBindingServiceFindBindingById(this, bindingId);
  }

  public async transitionBindingState(bindingId: string, newState: BindingStateType, reason: string, causedBy: string): Promise<Readonly<SurfaceBindingRecordView>> {
    return surfaceBindingServiceTransitionBindingState(this, bindingId, newState, reason, causedBy);
  }

  public async cascadeDetachBySurfaceId(surfaceId: string, workspaceId: string): Promise<void> {
    return surfaceBindingServiceCascadeDetachBySurfaceId(this, surfaceId, workspaceId);
  }

  public async findBindingsByObject(objectId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return surfaceBindingServiceFindBindingsByObject(this, objectId, workspaceId);
  }

  public async findBindingsBySurface(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return surfaceBindingServiceFindBindingsBySurface(this, surfaceId, workspaceId);
  }

  public async findBindingsByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return surfaceBindingServiceFindBindingsByWorkspace(this, workspaceId);
  }

  private async ensurePrimaryBindingAllowed(objectId: string, workspaceId: string, isPrimary: boolean): Promise<void> {
    return surfaceBindingServiceEnsurePrimaryBindingAllowed(this, objectId, workspaceId, isPrimary);
  }

  private async ensureCrossCuttingAllowsBinding(objectId: string, workspaceId: string, surfaceId: string): Promise<void> {
    return surfaceBindingServiceEnsureCrossCuttingAllowsBinding(this, objectId, workspaceId, surfaceId);
  }

  private buildBinding(input: Parameters<typeof surfaceBindingServiceBuildBinding>[1], timestamp: string): Readonly<SurfaceBinding> {
    return surfaceBindingServiceBuildBinding(this, input, timestamp);
  }

  private buildBindingCreatedEvent(bindingId: string, binding: Readonly<SurfaceBinding>): SurfaceBindingEventDraft {
    return surfaceBindingServiceBuildBindingCreatedEvent(this, bindingId, binding);
  }

  private async persistBindingWithEvent(binding: Readonly<SurfaceBinding>, bindingId: string, event: SurfaceBindingEventDraft): Promise<Readonly<SurfaceBindingRecordView>> {
    return surfaceBindingServicePersistBindingWithEvent(this, binding, bindingId, event);
  }

  private async acquireDriftLease(workspaceId: string, operationType: SurfaceDriftOperationType, grantedTo: string): Promise<string | null> {
    return surfaceBindingServiceAcquireDriftLease(this, workspaceId, operationType, grantedTo);
  }

  private async releaseDriftLeaseSafely(params: {
    readonly leaseId: string | null;
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly releasedBy: string;
    readonly failureMessage: string;
    readonly propagateFailure: boolean;
  }): Promise<void> {
    return surfaceBindingServiceReleaseDriftLeaseSafely(this, params);
  }

  private async classifyBindingDriftSafely(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    return surfaceBindingServiceClassifyBindingDriftSafely(this, params);
  }

  private async classifyBindingDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    return surfaceBindingServiceClassifyBindingDrift(this, params);
  }

  private requireEventPublisher(): SurfaceBindingEventPublisherPort {
    return surfaceBindingServiceRequireEventPublisher(this);
  }
}
