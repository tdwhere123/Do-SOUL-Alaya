import { randomUUID } from "node:crypto";
import {
  MemoryDimension,
  RevokeReason,
  type EventLogEntry,
  type GovernanceRoleState as GovernanceRoleStateType,
  type GreenStatus,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type ScopeClass,
  type VerificationBasis as VerificationBasisType,
  type VerificationResult,
  type VerificationVerdict as VerificationVerdictType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";

import { greenServiceGrant, greenServicePierce, greenServiceSetGrace } from "./green-service-methods-1.js";
import { greenServiceReevaluate, greenServiceRunVerification, greenServiceGetStatus, greenServiceFindEligible, greenServiceFindGrace, greenServiceFindAll } from "./green-service-methods-2.js";
import { greenServiceAssertGrantPreconditions, greenServiceGetMemoryOrThrow, greenServiceIsContested, greenServiceHasOpenCorrection, greenServiceHasHighRiskGuardHit, greenServiceEvaluatePiercingReason, greenServiceWarnMissingStatusResolver } from "./green-service-methods-3.js";

const LOW_SIGNAL_REASONS = new Set<RevokeReasonType>([RevokeReason.REVIEW_OVERDUE, RevokeReason.NONE]);

const ACTIVE_LIFECYCLE = "active";

const GRACE_HOURS_BY_DIMENSION: Readonly<Record<MemoryDimensionType, number | null>> = {
  [MemoryDimension.PREFERENCE]: null,
  [MemoryDimension.CONSTRAINT]: 24,
  [MemoryDimension.DECISION]: 24,
  [MemoryDimension.PROCEDURE]: 24,
  [MemoryDimension.FACT]: 72,
  [MemoryDimension.HAZARD]: 6,
  [MemoryDimension.GLOSSARY]: 72,
  [MemoryDimension.EPISODE]: null
} as const;

const NON_RECOVERABLE_REVOKE_REASONS = new Set<RevokeReasonType>([
  RevokeReason.EXTERNAL_INVALIDATION,
  RevokeReason.SECURITY_HIT,
  RevokeReason.REVIEW_OVERDUE,
  RevokeReason.VERIFICATION_FAIL
]);

export interface GreenServiceGreenStatusRepoPort {
  findByTargetObjectId(targetObjectId: string): Promise<Readonly<GreenStatus> | null>;
  findEligible(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  findGrace(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]>;
  upsert(greenStatus: Readonly<GreenStatus>): Promise<Readonly<GreenStatus>>;
}

export interface GreenServiceMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
}

export interface GreenServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByWorkspace(workspaceId: string): Promise<readonly EventLogEntry[]>;
  queryByType(eventType: string): Promise<readonly EventLogEntry[]>;
  hasOpenSessionOverrideCorrection(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly nowIso: string;
  }): Promise<boolean>;
  hasSecurityHitForTarget(query: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
  }): Promise<boolean>;
}

export interface GreenServiceLeasePort {
  isHeld(runId: string): Promise<boolean>;
}

export interface GreenServiceStatusResolverPort {
  getGovernanceRole(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
  }): Promise<GovernanceRoleStateType | null>;
}

export interface GreenRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface GreenWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export type GreenServiceReevaluationOutcome = "granted" | "grace" | "unchanged" | "pierced";

export interface GreenServiceDependencies {
  readonly greenStatusRepo: GreenServiceGreenStatusRepoPort;
  readonly memoryRepo: GreenServiceMemoryRepoPort;
  readonly eventLogRepo: GreenServiceEventLogRepoPort;
  readonly runtimeNotifier: GreenRuntimeNotifier;
  readonly statusResolver?: GreenServiceStatusResolverPort;
  readonly leaseService?: GreenServiceLeasePort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
  readonly warn?: GreenWarnPort;
}

export class GreenService {
public static readonly VERIFICATION_MAX_CONSECUTIVE_NO_GO = 3;

public readonly generateObjectId: () => string;

public readonly now: () => string;

public readonly warn: GreenWarnPort;

public readonly consecutiveNoGo = new Map<string, number>();

public hasWarnedMissingStatusResolver = false;

public constructor(public readonly dependencies: GreenServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
  }

  public async grant(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly validUntil: string | null;
    readonly verifiedBy: VerifiedByType;
    readonly boundSurfaces?: readonly string[] | null;
    readonly boundScopeClass?: ScopeClass | null;
  }): Promise<Readonly<GreenStatus>> {
    return greenServiceGrant(this, params);
  }

  public async pierce(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: RevokeReasonType;
    readonly runId?: string;
  }): Promise<Readonly<GreenStatus> | null> {
    return greenServicePierce(this, params);
  }

  public async setGrace(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly until: string;
    readonly runId?: string;
    readonly reason?: "valid_until_expired" | "manual";
  }): Promise<Readonly<GreenStatus> | null> {
    return greenServiceSetGrace(this, params);
  }

  public async reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly runId?: string;
  }): Promise<GreenServiceReevaluationOutcome> {
    return greenServiceReevaluate(this, params);
  }

  public async runVerification(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly verdict: VerificationVerdictType;
    readonly microCorrectionHint: string | null;
    readonly necessaryPatch: string | null;
  }): Promise<Readonly<VerificationResult>> {
    return greenServiceRunVerification(this, params);
  }

  public async getStatus(targetObjectId: string): Promise<Readonly<GreenStatus> | null> {
    return greenServiceGetStatus(this, targetObjectId);
  }

  public async findEligible(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return greenServiceFindEligible(this, workspaceId);
  }

  public async findGrace(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return greenServiceFindGrace(this, workspaceId);
  }

  public async findAll(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return greenServiceFindAll(this, workspaceId);
  }

  private async assertGrantPreconditions(params: {
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly boundSurfaces: readonly string[] | null;
    readonly boundScopeClass: ScopeClass | null;
  }): Promise<void> {
    return greenServiceAssertGrantPreconditions(this, params);
  }

  private async getMemoryOrThrow(targetObjectId: string): Promise<Readonly<MemoryEntry>> {
    return greenServiceGetMemoryOrThrow(this, targetObjectId);
  }

  private async isContested(targetObjectId: string, workspaceId: string): Promise<boolean> {
    return greenServiceIsContested(this, targetObjectId, workspaceId);
  }

  private async hasOpenCorrection(targetObjectId: string, workspaceId: string): Promise<boolean> {
    return greenServiceHasOpenCorrection(this, targetObjectId, workspaceId);
  }

  private async hasHighRiskGuardHit(targetObjectId: string, workspaceId: string): Promise<boolean> {
    return greenServiceHasHighRiskGuardHit(this, targetObjectId, workspaceId);
  }

  private async evaluatePiercingReason(params: {
    readonly existing: Readonly<GreenStatus>;
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
  }): Promise<RevokeReasonType | null> {
    return greenServiceEvaluatePiercingReason(this, params);
  }

  private warnMissingStatusResolver(workspaceId: string, targetObjectId: string): void {
    return greenServiceWarnMissingStatusResolver(this, workspaceId, targetObjectId);
  }
}
