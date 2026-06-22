import { randomUUID } from "node:crypto";

import {
  ControlPlaneObjectKind,
  GreenState,
  GreenStatusSchema,
  GreenGovernanceEventType,
  MemoryDimension,
  RevokeReason,
  SoulGreenGraceEnteredPayloadSchema,
  SoulGreenGrantedPayloadSchema,
  SoulGreenPiercedPayloadSchema,
  SoulVerificationCompletedPayloadSchema,
  VerificationBasis,
  VerificationResultSchema,
  VerificationVerdict,
  type GreenStatus,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type ScopeClass,
  type VerificationBasis as VerificationBasisType,
  type VerificationResult,
  type VerificationVerdict as VerificationVerdictType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";

import { parseNonEmptyString, parseObjectId } from "../shared/validators.js";

import { GreenGrantGuard } from "./green-grant-guard.js";
import {
  ACTIVE_LIFECYCLE,
  LOW_SIGNAL_REASONS,
  calculateGraceUntil,
  calculateValidUntil,
  determineReevaluationBasis,
  determineVerifiedByForBasis,
  isExpired,
  normalizeBoundSurfaces,
  resolveVerifiedBy,
  type GreenServiceDependencies,
  type GreenServiceReevaluationOutcome,
  type GreenWarnPort
} from "./green-service-ports.js";

export type {
  GreenRuntimeNotifier,
  GreenServiceDependencies,
  GreenServiceEventLogRepoPort,
  GreenServiceGreenStatusRepoPort,
  GreenServiceLeasePort,
  GreenServiceMemoryRepoPort,
  GreenServiceReevaluationOutcome,
  GreenServiceStatusResolverPort,
  GreenWarnPort
} from "./green-service-ports.js";

interface ReevaluationContext {
  readonly targetObjectId: string;
  readonly workspaceId: string;
  readonly memory: Readonly<MemoryEntry>;
  readonly existing: Readonly<GreenStatus> | null;
  readonly nowIso: string;
  readonly runId?: string;
}

const DEFAULT_CONSECUTIVE_NO_GO_MAX_ENTRIES = 10_000;

export class GreenService {
  public static readonly VERIFICATION_MAX_CONSECUTIVE_NO_GO = 3;

  public readonly generateObjectId: () => string;

  public readonly now: () => string;

  public readonly warn: GreenWarnPort;

  public readonly consecutiveNoGo = new Map<string, number>();

  private readonly guard: GreenGrantGuard;
  private readonly consecutiveNoGoMaxEntries: number;

  public constructor(public readonly dependencies: GreenServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
    this.consecutiveNoGoMaxEntries = normalizePositiveInteger(
      dependencies.consecutiveNoGoMaxEntries,
      DEFAULT_CONSECUTIVE_NO_GO_MAX_ENTRIES
    );
    this.guard = new GreenGrantGuard({
      memoryRepo: dependencies.memoryRepo,
      eventLogRepo: dependencies.eventLogRepo,
      statusResolver: dependencies.statusResolver,
      now: this.now,
      warn: this.warn
    });
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
    const memory = await this.guard.getMemoryOrThrow(targetObjectId);
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    await this.guard.assertGrantPreconditions({
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

    const memory = await this.guard.getMemoryOrThrow(targetObjectId);
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
    const memory = await this.guard.getMemoryOrThrow(targetObjectId);
    const existing = await this.dependencies.greenStatusRepo.findByTargetObjectId(targetObjectId);
    const ctx: ReevaluationContext = {
      targetObjectId,
      workspaceId,
      memory,
      existing,
      nowIso: this.now(),
      runId: params.runId
    };

    if (existing?.green_state === GreenState.GRACE && isExpired(existing.valid_until, ctx.nowIso)) {
      return this.reevaluateExpiredGrace(ctx, existing);
    }

    if (existing?.green_state === GreenState.ELIGIBLE && isExpired(existing.valid_until, ctx.nowIso)) {
      return this.reevaluateExpiredEligible(ctx);
    }

    const piercingOutcome = await this.reevaluatePiercing(ctx);
    if (piercingOutcome !== null) {
      return piercingOutcome;
    }

    if (existing?.green_state === GreenState.ELIGIBLE) {
      return "unchanged";
    }

    return this.reevaluateGrant(ctx);
  }

  private async reevaluateExpiredGrace(
    ctx: ReevaluationContext,
    existing: Readonly<GreenStatus>
  ): Promise<GreenServiceReevaluationOutcome> {
    const pierced = await this.pierce({
      targetObjectId: ctx.targetObjectId,
      workspaceId: ctx.workspaceId,
      reason: RevokeReason.REVIEW_OVERDUE,
      runId: ctx.runId
    });
    return pierced === null || pierced.green_state === existing.green_state ? "unchanged" : "pierced";
  }

  private async reevaluateExpiredEligible(
    ctx: ReevaluationContext
  ): Promise<GreenServiceReevaluationOutcome> {
    const graceUntil = calculateGraceUntil(ctx.memory.dimension, ctx.nowIso);
    if (graceUntil === null) {
      return "unchanged";
    }

    const grace = await this.setGrace({
      targetObjectId: ctx.targetObjectId,
      workspaceId: ctx.workspaceId,
      until: graceUntil,
      runId: ctx.runId ?? ctx.memory.run_id,
      reason: "valid_until_expired"
    });
    return grace === null ? "unchanged" : "grace";
  }

  private async reevaluatePiercing(
    ctx: ReevaluationContext
  ): Promise<GreenServiceReevaluationOutcome | null> {
    const piercingReason =
      ctx.existing === null
        ? null
        : await this.guard.evaluatePiercingReason({
            existing: ctx.existing,
            memory: ctx.memory,
            workspaceId: ctx.workspaceId
          });

    if (piercingReason === null) {
      return null;
    }

    const pierced = await this.pierce({
      targetObjectId: ctx.targetObjectId,
      workspaceId: ctx.workspaceId,
      reason: piercingReason,
      runId: ctx.runId
    });
    return pierced === null ? "unchanged" : "pierced";
  }

  private async reevaluateGrant(
    ctx: ReevaluationContext
  ): Promise<GreenServiceReevaluationOutcome> {
    if (ctx.memory.lifecycle_state !== ACTIVE_LIFECYCLE || ctx.memory.evidence_refs.length === 0) {
      return "unchanged";
    }

    const basis = determineReevaluationBasis(ctx.memory, ctx.existing);
    if (basis === null) {
      return "unchanged";
    }

    await this.grant({
      targetObjectId: ctx.targetObjectId,
      workspaceId: ctx.workspaceId,
      basis,
      validUntil: calculateValidUntil(ctx.memory.dimension, ctx.nowIso),
      verifiedBy: determineVerifiedByForBasis(basis),
      boundSurfaces: ctx.memory.surface_id === null ? null : [ctx.memory.surface_id],
      boundScopeClass: ctx.memory.scope_class
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
    const memory = await this.guard.getMemoryOrThrow(targetObjectId);
    const currentCount = this.readConsecutiveNoGo(targetObjectId);
    const timestamp = this.now();

    let count = currentCount;
    let hint = params.microCorrectionHint;

    if (params.verdict === VerificationVerdict.NO_GO) {
      const maxNoGo = GreenService.VERIFICATION_MAX_CONSECUTIVE_NO_GO;
      if (currentCount >= maxNoGo) {
        count = maxNoGo;
        hint = "max retries reached";
      } else {
        count = currentCount + 1;
        this.writeConsecutiveNoGo(targetObjectId, count);
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

  private readConsecutiveNoGo(targetObjectId: string): number {
    const count = this.consecutiveNoGo.get(targetObjectId);
    if (count === undefined) {
      return 0;
    }
    this.consecutiveNoGo.delete(targetObjectId);
    this.consecutiveNoGo.set(targetObjectId, count);
    return count;
  }

  private writeConsecutiveNoGo(targetObjectId: string, count: number): void {
    if (this.consecutiveNoGo.has(targetObjectId)) {
      this.consecutiveNoGo.delete(targetObjectId);
    }
    while (this.consecutiveNoGo.size >= this.consecutiveNoGoMaxEntries) {
      const oldestTargetObjectId = this.consecutiveNoGo.keys().next().value;
      if (typeof oldestTargetObjectId !== "string") {
        break;
      }
      this.consecutiveNoGo.delete(oldestTargetObjectId);
      this.warn("[GreenService] consecutive No-Go cache entry evicted.", {
        targetObjectId: oldestTargetObjectId,
        maxEntries: this.consecutiveNoGoMaxEntries
      });
    }
    this.consecutiveNoGo.set(targetObjectId, count);
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
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
