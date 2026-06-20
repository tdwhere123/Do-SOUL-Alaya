
import {
  BindingState,
  BindingStateSchema,
  canonicalGovernanceSubject,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  SurfaceBindingSchema,
  type BindingState as BindingStateType,
  type CrossCuttingPermission,
  type EventLogEntry,
  type SurfaceDriftOperationType,
  type SurfaceBinding
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import type { EventPublisher } from "../runtime/event-publisher.js";



import { parseSurfaceUri } from "../shared/surface-uri.js";

import { parseNonEmptyString } from "../shared/validators.js";

type SurfaceBindingServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  warn: (message: string, meta: Record<string, unknown>) => void;
  dependencies: SurfaceBindingServiceDependencies;
  [key: string]: any;
};


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

function parseBindObjectInput(input: {
  readonly object_id: string;
  readonly surface_id: string;
  readonly is_primary: boolean;
  readonly workspace_id: string;
  readonly created_by: string;
}) {
  return {
    object_id: parseNonEmptyString(input.object_id, "object_id"),
    surface_id: parseSurfaceUri(input.surface_id, "surface_id"),
    is_primary: input.is_primary,
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
    created_by: parseNonEmptyString(input.created_by, "created_by")
  };
}

function parseBindingState(value: BindingStateType): BindingStateType {
  try {
    return BindingStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid binding state", { cause: error });
  }
}

function parseSurfaceBinding(value: SurfaceBinding): SurfaceBinding {
  try {
    return SurfaceBindingSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface binding payload", { cause: error });
  }
}

function parseReason(value: string): string {
  return parseNonEmptyString(value, "reason");
}

function parseCausedBy(value: string): string {
  return parseNonEmptyString(value, "caused_by");
}

function ensureValidBindingTransition(from: BindingStateType, to: BindingStateType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Binding state transition must change state");
  }

  if (!BINDING_STATE_TRANSITIONS[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid binding state transition: ${from} -> ${to}`);
  }
}

export async function surfaceBindingServiceReleaseDriftLeaseSafely(owner: SurfaceBindingServiceMethodOwner, params: {
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
      owner.warn("Surface binding drift lease release failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        leaseId: params.leaseId,
        error
      });
    }
  }

export async function surfaceBindingServiceClassifyBindingDriftSafely(owner: SurfaceBindingServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    try {
      await owner.classifyBindingDrift(params);
    } catch (error) {
      owner.warn("Surface binding drift telemetry failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        driftType: params.driftType,
        error
      });
    }
  }

export async function surfaceBindingServiceClassifyBindingDrift(owner: SurfaceBindingServiceMethodOwner, params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    const driftService = owner.dependencies.surfaceDriftService;

    if (driftService === undefined) {
      return;
    }

    const classification = await driftService.classifyDrift({
      workspaceId: params.workspaceId,
      driftType: params.driftType,
      affectedSubject: SURFACE_BINDING_GOVERNANCE_SUBJECT,
      description: params.description
    });

    await driftService.alertOnCriticalDrift(classification);
  }

export function surfaceBindingServiceRequireEventPublisher(owner: SurfaceBindingServiceMethodOwner): SurfaceBindingEventPublisherPort {
    return owner.dependencies.eventPublisher;
  }
