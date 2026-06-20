import {
  GreenState,
  MemoryDimension,
  RevokeReason,
  VERIFICATION_VALID_UNTIL_BY_DIMENSION,
  VerificationBasis,
  VerifiedBy,
  type EventLogEntry,
  type GovernanceRoleState as GovernanceRoleStateType,
  type GreenStatus,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type VerificationBasis as VerificationBasisType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";

export const LOW_SIGNAL_REASONS = new Set<RevokeReasonType>([RevokeReason.REVIEW_OVERDUE, RevokeReason.NONE]);

export const ACTIVE_LIFECYCLE = "active";

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

export function basisAllowedForDimension(
  dimension: MemoryDimensionType,
  basis: VerificationBasisType
): boolean {
  switch (dimension) {
    case MemoryDimension.PREFERENCE:
    case MemoryDimension.EPISODE:
      return true;
    case MemoryDimension.FACT:
    case MemoryDimension.GLOSSARY:
    case MemoryDimension.DECISION:
      return basis !== VerificationBasis.PASSIVE_STABLE;
    case MemoryDimension.CONSTRAINT:
    case MemoryDimension.PROCEDURE:
      return basis === VerificationBasis.ACTIVE_VERIFICATION || basis === VerificationBasis.DETERMINISTIC_CHECK;
    case MemoryDimension.HAZARD:
      return basis === VerificationBasis.USER_RECONFIRM;
    default:
      return false;
  }
}

export function requiresSurfaceBinding(dimension: MemoryDimensionType): boolean {
  return dimension === MemoryDimension.CONSTRAINT || dimension === MemoryDimension.PROCEDURE;
}

export function normalizeBoundSurfaces(
  boundSurfaces: readonly string[] | null | undefined,
  surfaceId: string | null
): readonly string[] | null {
  if (boundSurfaces !== undefined && boundSurfaces !== null && boundSurfaces.length > 0) {
    return Object.freeze([...new Set(boundSurfaces)]);
  }

  if (surfaceId !== null) {
    return Object.freeze([surfaceId]);
  }

  return null;
}

export function isSurfaceDetached(status: Readonly<GreenStatus>, surfaceId: string | null): boolean {
  if (status.bound_surfaces === null || status.bound_surfaces.length === 0) {
    return false;
  }

  return surfaceId === null || !status.bound_surfaces.includes(surfaceId);
}

export function resolveVerifiedBy(
  dimension: MemoryDimensionType,
  verifiedBy: VerifiedByType
): VerifiedByType {
  if (dimension === MemoryDimension.HAZARD) {
    return VerifiedBy.USER;
  }

  return verifiedBy;
}

export function determineVerifiedByForBasis(basis: VerificationBasisType): VerifiedByType {
  switch (basis) {
    case VerificationBasis.DETERMINISTIC_CHECK:
      return VerifiedBy.DETERMINISTIC_CHECKER;
    case VerificationBasis.USER_RECONFIRM:
      return VerifiedBy.USER;
    case VerificationBasis.PASSIVE_STABLE:
    case VerificationBasis.ACTIVE_VERIFICATION:
    default:
      return VerifiedBy.REVIEW;
  }
}

export function determineReevaluationBasis(
  memory: Readonly<MemoryEntry>,
  existing: Readonly<GreenStatus> | null
): VerificationBasisType | null {
  if (existing === null) {
    if (memory.dimension === MemoryDimension.PREFERENCE || memory.dimension === MemoryDimension.EPISODE) {
      return VerificationBasis.PASSIVE_STABLE;
    }

    return null;
  }

  if (existing.green_state === GreenState.GRACE) {
    return null;
  }

  if (existing.green_state === GreenState.REVOKED && NON_RECOVERABLE_REVOKE_REASONS.has(existing.revoke_reason)) {
    return null;
  }

  return existing.verification_basis;
}

export function calculateValidUntil(dimension: MemoryDimensionType, nowIso: string): string | null {
  const days =
    (VERIFICATION_VALID_UNTIL_BY_DIMENSION as Partial<Record<MemoryDimensionType, number | null>>)[dimension] ??
    null;

  if (days === null) {
    return null;
  }

  return addHours(nowIso, days * 24);
}

export function calculateGraceUntil(dimension: MemoryDimensionType, nowIso: string): string | null {
  const hours = GRACE_HOURS_BY_DIMENSION[dimension];

  if (hours === null) {
    return null;
  }

  return addHours(nowIso, hours);
}

function addHours(nowIso: string, hours: number): string {
  const timestamp = new Date(nowIso);
  timestamp.setTime(timestamp.getTime() + hours * 60 * 60 * 1000);
  return timestamp.toISOString();
}

export function isExpired(timestamp: string | null, nowIso: string): boolean {
  if (timestamp === null) {
    return false;
  }

  return new Date(timestamp).getTime() <= new Date(nowIso).getTime();
}
