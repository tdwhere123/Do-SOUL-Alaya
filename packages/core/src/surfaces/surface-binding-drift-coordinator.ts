import {
  canonicalGovernanceSubject,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType
} from "@do-soul/alaya-protocol";

import { DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS } from "./surface-drift-service.js";

const SURFACE_BINDING_GOVERNANCE_SUBJECT = canonicalGovernanceSubject("surface_governance", {
  entity: "binding"
}).canonical_key;

export interface SurfaceBindingDriftGovernancePort {
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

export interface SurfaceBindingDriftCoordinatorDependencies {
  readonly surfaceDriftService?: SurfaceBindingDriftGovernancePort;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export class SurfaceBindingDriftCoordinator {
  private readonly surfaceDriftService?: SurfaceBindingDriftGovernancePort;

  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(dependencies: SurfaceBindingDriftCoordinatorDependencies) {
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
    readonly failureMessage: string;
    readonly propagateFailure: boolean;
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
      this.warn("Surface binding drift lease release failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        leaseId: params.leaseId,
        error
      });
    }
  }

  public async classifyDriftSafely(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    try {
      await this.classifyDrift(params);
    } catch (error) {
      this.warn("Surface binding drift telemetry failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        driftType: params.driftType,
        error
      });
    }
  }

  private async classifyDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    const driftService = this.surfaceDriftService;

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
}
