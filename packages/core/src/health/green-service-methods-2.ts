
import {
  ControlPlaneObjectKind,
  GreenState,
  MemoryDimension,
  GreenGovernanceEventType,
  RevokeReason,
  SoulVerificationCompletedPayloadSchema,
  VERIFICATION_VALID_UNTIL_BY_DIMENSION,
  VerificationBasis,
  VerificationResultSchema,
  VerificationVerdict,
  VerifiedBy,
  type EventLogEntry,
  type GovernanceRoleState as GovernanceRoleStateType,
  type GreenStatus,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type VerificationBasis as VerificationBasisType,
  type VerificationResult,
  type VerificationVerdict as VerificationVerdictType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";


import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";
type GreenServiceMethodOwner = {
  generateObjectId: () => string;
  now: () => string;
  warn: GreenWarnPort;
  consecutiveNoGo: any;
  hasWarnedMissingStatusResolver: any;
  dependencies: GreenServiceDependencies;
  [key: string]: any;
};


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

function basisAllowedForDimension(
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

function requiresSurfaceBinding(dimension: MemoryDimensionType): boolean {
  return dimension === MemoryDimension.CONSTRAINT || dimension === MemoryDimension.PROCEDURE;
}

function normalizeBoundSurfaces(
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

function isSurfaceDetached(status: Readonly<GreenStatus>, surfaceId: string | null): boolean {
  if (status.bound_surfaces === null || status.bound_surfaces.length === 0) {
    return false;
  }

  return surfaceId === null || !status.bound_surfaces.includes(surfaceId);
}

function hasSecurityHitRevokeReason(payload: Readonly<Record<string, unknown>>): boolean {
  return payload["revoke_reason"] === RevokeReason.SECURITY_HIT;
}

function hasTargetObjectId(payload: Readonly<Record<string, unknown>>, targetObjectId: string): boolean {
  return payload["target_object_id"] === targetObjectId;
}

function resolveVerifiedBy(
  dimension: MemoryDimensionType,
  verifiedBy: VerifiedByType
): VerifiedByType {
  if (dimension === MemoryDimension.HAZARD) {
    return VerifiedBy.USER;
  }

  return verifiedBy;
}

function determineVerifiedByForBasis(basis: VerificationBasisType): VerifiedByType {
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

function determineReevaluationBasis(
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

function calculateValidUntil(dimension: MemoryDimensionType, nowIso: string): string | null {
  const days =
    (VERIFICATION_VALID_UNTIL_BY_DIMENSION as Partial<Record<MemoryDimensionType, number | null>>)[dimension] ??
    null;

  if (days === null) {
    return null;
  }

  return addHours(nowIso, days * 24);
}

function calculateGraceUntil(dimension: MemoryDimensionType, nowIso: string): string | null {
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

function isExpired(timestamp: string | null, nowIso: string): boolean {
  if (timestamp === null) {
    return false;
  }

  return new Date(timestamp).getTime() <= new Date(nowIso).getTime();
}

export async function greenServiceReevaluate(owner: GreenServiceMethodOwner, params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly runId?: string;
  }): Promise<GreenServiceReevaluationOutcome> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await owner.getMemoryOrThrow(targetObjectId);
    const existing = await owner.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    const nowIso = owner.now();

    if (existing?.green_state === GreenState.GRACE && isExpired(existing.valid_until, nowIso)) {
      const pierced = await owner.pierce({
        targetObjectId,
        workspaceId,
        reason: RevokeReason.REVIEW_OVERDUE,
        runId: params.runId
      });
      return pierced === null || pierced.green_state === existing.green_state ? "unchanged" : "pierced";
    }

    if (existing?.green_state === GreenState.ELIGIBLE && isExpired(existing.valid_until, nowIso)) {
      const graceUntil = calculateGraceUntil(memory.dimension, nowIso);

      if (graceUntil === null) {
        return "unchanged";
      }

      const grace = await owner.setGrace({
        targetObjectId,
        workspaceId,
        until: graceUntil,
        runId: params.runId ?? memory.run_id,
        reason: "valid_until_expired"
      });
      return grace === null ? "unchanged" : "grace";
    }

    const piercingReason =
      existing === null
        ? null
        : await owner.evaluatePiercingReason({
            existing,
            memory,
            workspaceId
          });

    if (piercingReason !== null) {
      const pierced = await owner.pierce({
        targetObjectId,
        workspaceId,
        reason: piercingReason,
        runId: params.runId
      });
      return pierced === null ? "unchanged" : "pierced";
    }

    if (existing?.green_state === GreenState.ELIGIBLE) {
      return "unchanged";
    }

    if (memory.lifecycle_state !== ACTIVE_LIFECYCLE || memory.evidence_refs.length === 0) {
      return "unchanged";
    }

    const basis = determineReevaluationBasis(memory, existing);
    if (basis === null) {
      return "unchanged";
    }

    await owner.grant({
      targetObjectId,
      workspaceId,
      basis,
      validUntil: calculateValidUntil(memory.dimension, nowIso),
      verifiedBy: determineVerifiedByForBasis(basis),
      boundSurfaces: memory.surface_id === null ? null : [memory.surface_id],
      boundScopeClass: memory.scope_class
    });

    return "granted";
  }

export async function greenServiceRunVerification(owner: GreenServiceMethodOwner, params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly verdict: VerificationVerdictType;
    readonly microCorrectionHint: string | null;
    readonly necessaryPatch: string | null;
  }): Promise<Readonly<VerificationResult>> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await owner.getMemoryOrThrow(targetObjectId);
    const currentCount = owner.consecutiveNoGo.get(targetObjectId) ?? 0;
    const timestamp = owner.now();

    let count = currentCount;
    let hint = params.microCorrectionHint;

    if (params.verdict === VerificationVerdict.NO_GO) {
      const maxNoGo = (owner.constructor as unknown as { readonly VERIFICATION_MAX_CONSECUTIVE_NO_GO: number })
        .VERIFICATION_MAX_CONSECUTIVE_NO_GO;
      if (currentCount >= maxNoGo) {
        count = maxNoGo;
        hint = "max retries reached";
      } else {
        count = currentCount + 1;
        owner.consecutiveNoGo.set(targetObjectId, count);
        await owner.pierce({
          targetObjectId,
          workspaceId,
          reason: RevokeReason.VERIFICATION_FAIL,
          runId: memory.run_id
        });
      }
    } else {
      owner.consecutiveNoGo.delete(targetObjectId);
      count = 0;
      const basis =
        memory.dimension === MemoryDimension.HAZARD
          ? VerificationBasis.USER_RECONFIRM
          : VerificationBasis.ACTIVE_VERIFICATION;
      await owner.grant({
        targetObjectId,
        workspaceId,
        basis,
        validUntil: calculateValidUntil(memory.dimension, timestamp),
        verifiedBy: determineVerifiedByForBasis(basis),
        boundSurfaces: memory.surface_id === null ? null : [memory.surface_id],
        boundScopeClass: memory.scope_class
      });
    }

    const verificationResult = VerificationResultSchema.parse({
      runtime_id: owner.generateObjectId(),
      object_kind: ControlPlaneObjectKind.VERIFICATION_RESULT,
      task_surface_ref: null,
      expires_at: null,
      derived_from: targetObjectId,
      retention_policy: "session_only",
      verdict: params.verdict,
      micro_correction_hint: hint,
      necessary_patch: params.necessaryPatch
    });
    const event = await owner.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_VERIFICATION_COMPLETED,
      entity_type: "verification_result",
      entity_id: verificationResult.runtime_id,
      workspace_id: workspaceId,
      run_id: memory.run_id,
      caused_by: "system",
      payload_json: SoulVerificationCompletedPayloadSchema.parse({
        target_object_id: targetObjectId,
        verdict: verificationResult.verdict,
        micro_correction_hint: verificationResult.micro_correction_hint,
        consecutive_no_go_count: count,
        workspace_id: workspaceId,
        occurred_at: timestamp
      })
    });

    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return verificationResult;
  }

export async function greenServiceGetStatus(owner: GreenServiceMethodOwner, targetObjectId: string): Promise<Readonly<GreenStatus> | null> {
    return await owner.dependencies.greenStatusRepo.findByTargetObjectId(parseObjectId(targetObjectId));
  }

export async function greenServiceFindEligible(owner: GreenServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await owner.dependencies.greenStatusRepo.findEligible(parseNonEmptyString(workspaceId, "workspaceId"));
  }

export async function greenServiceFindGrace(owner: GreenServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await owner.dependencies.greenStatusRepo.findGrace(parseNonEmptyString(workspaceId, "workspaceId"));
  }

export async function greenServiceFindAll(owner: GreenServiceMethodOwner, workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await owner.dependencies.greenStatusRepo.findByWorkspaceId(parseNonEmptyString(workspaceId, "workspaceId"));
  }
