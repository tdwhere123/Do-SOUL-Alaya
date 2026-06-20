import { randomUUID } from "node:crypto";

import {
  ControlPlaneObjectKind,
  GovernanceRoleState,
  GreenState,
  GreenStatusSchema,
  MemoryDimension,
  GreenGovernanceEventType,
  RevokeReason,
  SoulGreenGraceEnteredPayloadSchema,
  SoulGreenGrantedPayloadSchema,
  SoulGreenPiercedPayloadSchema,
  SoulSessionOverrideAppliedPayloadSchema,
  SoulSessionOverridePromotedPayloadSchema,
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
  type ScopeClass,
  type VerificationBasis as VerificationBasisType,
  type VerificationResult,
  type VerificationVerdict as VerificationVerdictType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

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

export async function greenServiceGrant(owner: GreenServiceMethodOwner, params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly validUntil: string | null;
    readonly verifiedBy: VerifiedByType;
    readonly boundSurfaces?: readonly string[] | null;
    readonly boundScopeClass?: ScopeClass | null;
  }): Promise<Readonly<GreenStatus>> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await owner.getMemoryOrThrow(targetObjectId);
    const existing = await owner.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    await owner.assertGrantPreconditions({
      memory,
      workspaceId,
      basis: params.basis,
      boundSurfaces: params.boundSurfaces ?? null,
      boundScopeClass: params.boundScopeClass ?? null
    });

    const timestamp = owner.now();
    const status = GreenStatusSchema.parse({
      object_id: existing?.object_id ?? owner.generateObjectId(),
      object_kind: "green_status",
      schema_version: 1,
      lifecycle_state: ACTIVE_LIFECYCLE,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      created_by: existing?.created_by ?? "system",
      target_object_id: targetObjectId,
      target_object_kind: "memory_entry",
      green_state: GreenState.ELIGIBLE,
      verification_basis: params.basis,
      verified_by: resolveVerifiedBy(memory.dimension, params.verifiedBy),
      verified_at: timestamp,
      valid_until: params.validUntil,
      bound_surfaces: normalizeBoundSurfaces(params.boundSurfaces, memory.surface_id),
      bound_scope_class: params.boundScopeClass ?? memory.scope_class,
      revoke_reason: RevokeReason.NONE,
      last_transition_at: timestamp,
      workspace_id: workspaceId
    });
    const event = await owner.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GREEN_GRANTED,
      entity_type: "green_status",
      entity_id: status.object_id,
      workspace_id: workspaceId,
      run_id: memory.run_id,
      caused_by: "system",
      payload_json: SoulGreenGrantedPayloadSchema.parse({
        object_id: status.object_id,
        target_object_id: targetObjectId,
        verification_basis: status.verification_basis,
        valid_until: status.valid_until,
        bound_scope_class: status.bound_scope_class,
        workspace_id: workspaceId,
        occurred_at: timestamp
      })
    });

    const saved = await owner.dependencies.greenStatusRepo.upsert(status);
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }

export async function greenServicePierce(owner: GreenServiceMethodOwner, params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: RevokeReasonType;
    readonly runId?: string;
  }): Promise<Readonly<GreenStatus> | null> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const existing = await owner.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);

    if (existing === null) {
      return null;
    }

    if (
      params.runId !== undefined &&
      (await owner.dependencies.leaseService?.isHeld(params.runId)) === true &&
      LOW_SIGNAL_REASONS.has(params.reason)
    ) {
      return existing;
    }

    const memory = await owner.getMemoryOrThrow(targetObjectId);
    const timestamp = owner.now();
    const next = GreenStatusSchema.parse({
      ...existing,
      updated_at: timestamp,
      green_state: GreenState.REVOKED,
      revoke_reason: params.reason,
      last_transition_at: timestamp
    });
    const event = await owner.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
      entity_type: "green_status",
      entity_id: next.object_id,
      workspace_id: workspaceId,
      run_id: params.runId ?? memory.run_id,
      caused_by: "system",
      payload_json: SoulGreenPiercedPayloadSchema.parse({
        object_id: next.object_id,
        target_object_id: targetObjectId,
        revoke_reason: params.reason,
        workspace_id: workspaceId,
        occurred_at: timestamp
      })
    });

    const saved = await owner.dependencies.greenStatusRepo.upsert(next);
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }

export async function greenServiceSetGrace(owner: GreenServiceMethodOwner, params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly until: string;
    readonly runId?: string;
    readonly reason?: "valid_until_expired" | "manual";
  }): Promise<Readonly<GreenStatus> | null> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    parseNonEmptyString(params.until, "until");
    const runId = params.runId === undefined ? null : parseNonEmptyString(params.runId, "runId");
    const reason = params.reason ?? "manual";
    const existing = await owner.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);

    if (existing === null) {
      return null;
    }

    const timestamp = owner.now();
    const next = GreenStatusSchema.parse({
      ...existing,
      updated_at: timestamp,
      green_state: GreenState.GRACE,
      revoke_reason: RevokeReason.NONE,
      valid_until: params.until,
      last_transition_at: timestamp
    });
    const event = await owner.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GREEN_GRACE_ENTERED,
      entity_type: "green_status",
      entity_id: next.object_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "system",
      payload_json: SoulGreenGraceEnteredPayloadSchema.parse({
        object_id: next.object_id,
        target_object_id: targetObjectId,
        valid_until: params.until,
        prior_green_state: existing.green_state,
        prior_valid_until: existing.valid_until,
        reason,
        workspace_id: workspaceId,
        occurred_at: timestamp
      })
    });

    const saved = await owner.dependencies.greenStatusRepo.upsert(next);
    await owner.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }
