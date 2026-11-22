import {
  canonicalGovernanceSubject,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType
} from "@do-soul/alaya-protocol";

import { DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS } from "./surface-drift-service.js";

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

interface SurfaceDriftCoordinatorDependencies {
  readonly entity: "status" | "binding";
  readonly surfaceDriftService?: SurfaceDriftGovernancePort;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export class SurfaceDriftCoordinator {
  private readonly affectedSubject: string;
  private readonly logLabel: string;
  private readonly surfaceDriftService?: SurfaceDriftGovernancePort;

  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(dependencies: SurfaceDriftCoordinatorDependencies) {
    const { entity } = dependencies;
    this.affectedSubject = canonicalGovernanceSubject("surface_governance", { entity }).canonical_key;
    this.logLabel = entity === "status" ? "Surface drift" : "Surface binding drift";
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
      this.warn(`${this.logLabel} lease release failed after durable mutation`, {
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
    readonly warningContext?: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const driftService = this.surfaceDriftService;
    if (driftService === undefined) {
      return;
    }

    try {
      const classification = await driftService.classifyDrift({
        workspaceId: params.workspaceId,
        driftType: params.driftType,
        affectedSubject: this.affectedSubject,
        description: params.description
      });
      await driftService.alertOnCriticalDrift(classification);
    } catch (error) {
      this.warn(`${this.logLabel} telemetry failed after durable mutation`, {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        ...(params.warningContext ?? { driftType: params.driftType }),
        error
      });
    }
  }
}
