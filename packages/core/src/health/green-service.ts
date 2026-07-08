import { randomUUID } from "node:crypto";

import {
  GreenState,
  GreenStatusSchema,
  GreenGovernanceEventType,
  RevokeReason,
  SoulGreenGraceEnteredPayloadSchema,
  SoulGreenGrantedPayloadSchema,
  SoulGreenPiercedPayloadSchema,
  type GreenStatus,
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
  defaultGreenWarn,
  normalizePositiveInteger
} from "./green-service-consecutive-no-go.js";
import { reevaluateGreenStatus } from "./green-service-reevaluation.js";
import { runGreenVerification } from "./green-service-verification.js";
import {
  ACTIVE_LIFECYCLE,
  LOW_SIGNAL_REASONS,
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
    this.warn = dependencies.warn ?? defaultGreenWarn;
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
    return await reevaluateGreenStatus({
      targetObjectId,
      workspaceId,
      memory,
      existing,
      nowIso: this.now(),
      runId: params.runId,
      evaluatePiercingReason: async (input) => await this.guard.evaluatePiercingReason(input),
      grant: async (input) => await this.grant(input),
      pierce: async (input) => await this.pierce(input),
      setGrace: async (input) => await this.setGrace(input)
    });
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
    const timestamp = this.now();

    return await runGreenVerification({
      targetObjectId,
      workspaceId,
      verdict: params.verdict,
      microCorrectionHint: params.microCorrectionHint,
      necessaryPatch: params.necessaryPatch,
      memory,
      timestamp,
      maxConsecutiveNoGo: GreenService.VERIFICATION_MAX_CONSECUTIVE_NO_GO,
      consecutiveNoGo: this.consecutiveNoGo,
      consecutiveNoGoMaxEntries: this.consecutiveNoGoMaxEntries,
      warn: this.warn,
      generateObjectId: this.generateObjectId,
      dependencies: this.dependencies,
      grant: async (input) => await this.grant(input),
      pierce: async (input) => await this.pierce(input)
    });
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
