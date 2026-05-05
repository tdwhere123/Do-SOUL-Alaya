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
import { CoreError } from "./errors.js";
import { parseNonEmptyString, parseObjectId } from "./shared/validators.js";

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

/**
 * Green verification retry counters are process-local only in Phase 3B.
 * Restarting the daemon resets consecutive `no_go` tracking for every object.
 */
export class GreenService {
  public static readonly VERIFICATION_MAX_CONSECUTIVE_NO_GO = 3;

  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly warn: GreenWarnPort;
  private readonly consecutiveNoGo = new Map<string, number>();
  private hasWarnedMissingStatusResolver = false;

  public constructor(private readonly dependencies: GreenServiceDependencies) {
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
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await this.getMemoryOrThrow(targetObjectId);
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    await this.assertGrantPreconditions({
      memory,
      workspaceId,
      basis: params.basis,
      boundSurfaces: params.boundSurfaces ?? null,
      boundScopeClass: params.boundScopeClass ?? null
    });

    const timestamp = this.now();
    const status = GreenStatusSchema.parse({
      object_id: existing?.object_id ?? this.generateObjectId(),
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
    const event = await this.dependencies.eventLogRepo.append({
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

    const saved = await this.dependencies.greenStatusRepo.upsert(status);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }

  public async pierce(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: RevokeReasonType;
    readonly runId?: string;
  }): Promise<Readonly<GreenStatus> | null> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);

    if (existing === null) {
      return null;
    }

    if (
      params.runId !== undefined &&
      (await this.dependencies.leaseService?.isHeld(params.runId)) === true &&
      LOW_SIGNAL_REASONS.has(params.reason)
    ) {
      return existing;
    }

    const memory = await this.getMemoryOrThrow(targetObjectId);
    const timestamp = this.now();
    const next = GreenStatusSchema.parse({
      ...existing,
      updated_at: timestamp,
      green_state: GreenState.REVOKED,
      revoke_reason: params.reason,
      last_transition_at: timestamp
    });
    const event = await this.dependencies.eventLogRepo.append({
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

    const saved = await this.dependencies.greenStatusRepo.upsert(next);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }

  public async setGrace(params: {
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
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);

    if (existing === null) {
      return null;
    }

    const timestamp = this.now();
    const next = GreenStatusSchema.parse({
      ...existing,
      updated_at: timestamp,
      green_state: GreenState.GRACE,
      revoke_reason: RevokeReason.NONE,
      valid_until: params.until,
      last_transition_at: timestamp
    });
    const event = await this.dependencies.eventLogRepo.append({
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

    const saved = await this.dependencies.greenStatusRepo.upsert(next);
    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return saved;
  }

  public async reevaluate(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly runId?: string;
  }): Promise<GreenServiceReevaluationOutcome> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await this.getMemoryOrThrow(targetObjectId);
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    const nowIso = this.now();

    if (existing?.green_state === GreenState.GRACE && isExpired(existing.valid_until, nowIso)) {
      const pierced = await this.pierce({
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

      const grace = await this.setGrace({
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
        : await this.evaluatePiercingReason({
            existing,
            memory,
            workspaceId
          });

    if (piercingReason !== null) {
      const pierced = await this.pierce({
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

    await this.grant({
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

  public async runVerification(params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly verdict: VerificationVerdictType;
    readonly microCorrectionHint: string | null;
    readonly necessaryPatch: string | null;
  }): Promise<Readonly<VerificationResult>> {
    const targetObjectId = parseObjectId(params.targetObjectId);
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const memory = await this.getMemoryOrThrow(targetObjectId);
    const currentCount = this.consecutiveNoGo.get(targetObjectId) ?? 0;
    const timestamp = this.now();

    let count = currentCount;
    let hint = params.microCorrectionHint;

    if (params.verdict === VerificationVerdict.NO_GO) {
      if (currentCount >= GreenService.VERIFICATION_MAX_CONSECUTIVE_NO_GO) {
        count = GreenService.VERIFICATION_MAX_CONSECUTIVE_NO_GO;
        hint = "max retries reached";
      } else {
        count = currentCount + 1;
        this.consecutiveNoGo.set(targetObjectId, count);
        await this.pierce({
          targetObjectId,
          workspaceId,
          reason: RevokeReason.VERIFICATION_FAIL,
          runId: memory.run_id
        });
      }
    } else {
      this.consecutiveNoGo.delete(targetObjectId);
      count = 0;
      const basis =
        memory.dimension === MemoryDimension.HAZARD
          ? VerificationBasis.USER_RECONFIRM
          : VerificationBasis.ACTIVE_VERIFICATION;
      await this.grant({
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
      runtime_id: this.generateObjectId(),
      object_kind: ControlPlaneObjectKind.VERIFICATION_RESULT,
      task_surface_ref: null,
      expires_at: null,
      derived_from: targetObjectId,
      retention_policy: "session_only",
      verdict: params.verdict,
      micro_correction_hint: hint,
      necessary_patch: params.necessaryPatch
    });
    const event = await this.dependencies.eventLogRepo.append({
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

    await this.dependencies.runtimeNotifier.notifyEntry(event);
    return verificationResult;
  }

  public async getStatus(targetObjectId: string): Promise<Readonly<GreenStatus> | null> {
    return await this.dependencies.greenStatusRepo.findByTargetObjectId(parseObjectId(targetObjectId));
  }

  public async findEligible(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await this.dependencies.greenStatusRepo.findEligible(parseNonEmptyString(workspaceId, "workspaceId"));
  }

  public async findGrace(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await this.dependencies.greenStatusRepo.findGrace(parseNonEmptyString(workspaceId, "workspaceId"));
  }

  public async findAll(workspaceId: string): Promise<readonly Readonly<GreenStatus>[]> {
    return await this.dependencies.greenStatusRepo.findByWorkspaceId(parseNonEmptyString(workspaceId, "workspaceId"));
  }

  private async assertGrantPreconditions(params: {
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly boundSurfaces: readonly string[] | null;
    readonly boundScopeClass: ScopeClass | null;
  }): Promise<void> {
    if (params.memory.workspace_id !== params.workspaceId) {
      throw new CoreError("VALIDATION", "Memory entry does not belong to the workspace");
    }

    if (params.memory.lifecycle_state !== ACTIVE_LIFECYCLE) {
      throw new CoreError("VALIDATION", "Only active memory entries can enter Green");
    }

    if (params.memory.evidence_refs.length === 0) {
      throw new CoreError("VALIDATION", "Green status requires evidence_refs");
    }

    if (await this.isContested(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Contested memory entries cannot enter Green");
    }

    if (await this.hasOpenCorrection(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Open session overrides block Green grant");
    }

    if (await this.hasHighRiskGuardHit(params.memory.object_id, params.workspaceId)) {
      throw new CoreError("CONFLICT", "Security guard hit blocks Green grant");
    }

    if (!basisAllowedForDimension(params.memory.dimension, params.basis)) {
      throw new CoreError(
        "VALIDATION",
        `Verification basis ${params.basis} is not allowed for ${params.memory.dimension}`
      );
    }

    if (
      requiresSurfaceBinding(params.memory.dimension) &&
      normalizeBoundSurfaces(params.boundSurfaces, params.memory.surface_id) === null
    ) {
      throw new CoreError("VALIDATION", `${params.memory.dimension} Green status requires a bound surface`);
    }

    if (params.boundScopeClass !== null && params.boundScopeClass !== params.memory.scope_class) {
      throw new CoreError("VALIDATION", "boundScopeClass must match the target memory scope_class");
    }
  }

  private async getMemoryOrThrow(targetObjectId: string): Promise<Readonly<MemoryEntry>> {
    const memory = await this.dependencies.memoryRepo.findById(targetObjectId);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", "Memory entry not found");
    }

    return memory;
  }

  private async isContested(targetObjectId: string, workspaceId: string): Promise<boolean> {
    if (this.dependencies.statusResolver === undefined) {
      this.warnMissingStatusResolver(workspaceId, targetObjectId);
      return false;
    }

    const governanceRole = await this.dependencies.statusResolver.getGovernanceRole({
      targetObjectId,
      workspaceId
    });
    return governanceRole === GovernanceRoleState.CONTESTED;
  }

  private async hasOpenCorrection(targetObjectId: string, workspaceId: string): Promise<boolean> {
    const workspaceEvents = await this.dependencies.eventLogRepo.queryByWorkspace(workspaceId);
    const appliedEvents = workspaceEvents.filter(
      (entry) => entry.event_type === GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED
    );
    const promotedEvents = workspaceEvents.filter(
      (entry) => entry.event_type === GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED
    );
    const promotedOverrideIds = new Set(
      promotedEvents
        .map((entry) => SoulSessionOverridePromotedPayloadSchema.safeParse(entry.payload_json))
        .flatMap((result) =>
          result.success && result.data.promotion_outcome !== "not_promoted"
            ? [result.data.override_id]
            : []
        )
    );

    return appliedEvents.some((entry) => {
      const parsed = SoulSessionOverrideAppliedPayloadSchema.safeParse(entry.payload_json);

      if (!parsed.success) {
        return false;
      }

      return (
        parsed.data.target_object === targetObjectId &&
        !promotedOverrideIds.has(parsed.data.override_id) &&
        !isExpired(parsed.data.expires_at, this.now())
      );
    });
  }

  private async hasHighRiskGuardHit(targetObjectId: string, workspaceId: string): Promise<boolean> {
    const entityEvents = await this.dependencies.eventLogRepo.queryByEntity("memory_entry", targetObjectId);

    if (entityEvents.some((entry) => hasSecurityHitRevokeReason(entry.payload_json))) {
      return true;
    }

    const workspaceEvents = await this.dependencies.eventLogRepo.queryByWorkspace(workspaceId);
    return workspaceEvents.some(
      (entry) =>
        entry.event_type === GreenGovernanceEventType.SOUL_GREEN_PIERCED &&
        hasTargetObjectId(entry.payload_json, targetObjectId) &&
        hasSecurityHitRevokeReason(entry.payload_json)
    );
  }

  private async evaluatePiercingReason(params: {
    readonly existing: Readonly<GreenStatus>;
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
  }): Promise<RevokeReasonType | null> {
    if (await this.isContested(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.CONTESTED;
    }

    if (await this.hasOpenCorrection(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.CORRECTION_OPEN;
    }

    if (await this.hasHighRiskGuardHit(params.memory.object_id, params.workspaceId)) {
      return RevokeReason.SECURITY_HIT;
    }

    if (isSurfaceDetached(params.existing, params.memory.surface_id)) {
      return RevokeReason.SURFACE_DETACHED;
    }

    if (params.memory.lifecycle_state !== ACTIVE_LIFECYCLE || params.memory.evidence_refs.length === 0) {
      return RevokeReason.EXTERNAL_INVALIDATION;
    }

    return null;
  }

  private warnMissingStatusResolver(workspaceId: string, targetObjectId: string): void {
    if (this.hasWarnedMissingStatusResolver) {
      return;
    }

    this.hasWarnedMissingStatusResolver = true;
    this.warn("[GreenService] statusResolver missing; contested Green checks are disabled.", {
      workspaceId,
      targetObjectId
    });
  }
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
