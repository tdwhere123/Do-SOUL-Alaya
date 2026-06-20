import {
  canonicalGovernanceSubject,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType,
  type SurfaceStatus as SurfaceStatusType
} from "@do-soul/alaya-protocol";

import { DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS } from "./surface-drift-service.js";

const SURFACE_STATUS_GOVERNANCE_SUBJECT = canonicalGovernanceSubject("surface_governance", {
  entity: "status"
}).canonical_key;

export interface SurfaceDriftGovernancePort {
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

export interface SurfaceDriftCoordinatorDependencies {
  readonly surfaceDriftService?: SurfaceDriftGovernancePort;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export class SurfaceDriftCoordinator {
  private readonly surfaceDriftService?: SurfaceDriftGovernancePort;

  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(dependencies: SurfaceDriftCoordinatorDependencies) {
    this.surfaceDriftService = dependencies.surfaceDriftService;
    this.warn = dependencies.warn;
  }

  public async acquireLease(
    workspaceId: string,
    operationType: SurfaceDriftOperationType,
    grantedTo: string
  ): Promise<string | null> {
    const driftService = this.surfaceDriftService;

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

  public async releaseLeaseSafely(params: {
    readonly leaseId: string | null;
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly releasedBy: string;
  }): Promise<void> {
    if (params.leaseId === null || this.surfaceDriftService === undefined) {
      return;
    }

    try {
      await this.surfaceDriftService.releaseLease(
        params.leaseId,
        params.workspaceId,
        params.releasedBy
      );
    } catch (error) {
      this.warn("Surface drift lease release failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        leaseId: params.leaseId,
        error
      });
    }
  }

  public async classifyStatusDriftSafely(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
    readonly driftType: DriftType;
  }): Promise<void> {
    try {
      await this.classifyStatusDrift(params);
    } catch (error) {
      this.warn("Surface drift telemetry failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        surfaceId: params.surfaceId,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        error
      });
    }
  }

  private async classifyStatusDrift(params: {
    readonly workspaceId: string;
    readonly surfaceId: string;
    readonly fromStatus: SurfaceStatusType;
    readonly toStatus: SurfaceStatusType;
    readonly driftType: DriftType;
  }): Promise<void> {
    const driftService = this.surfaceDriftService;

    if (driftService === undefined) {
      return;
    }

    const classification = await driftService.classifyDrift({
      workspaceId: params.workspaceId,
      driftType: params.driftType,
      affectedSubject: SURFACE_STATUS_GOVERNANCE_SUBJECT,
      description: `Surface ${params.surfaceId} status changed from ${params.fromStatus} to ${params.toStatus}`
    });

    await driftService.alertOnCriticalDrift(classification);
  }
}
