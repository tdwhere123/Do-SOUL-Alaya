import {
  ControlPlaneObjectKind,
  GreenGovernanceEventType,
  MemoryDimension,
  RevokeReason,
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

import {
  calculateValidUntil,
  determineVerifiedByForBasis,
  type GreenServiceDependencies,
  type GreenWarnPort
} from "./green-service-ports.js";
import { readConsecutiveNoGo, writeConsecutiveNoGo } from "./green-service-consecutive-no-go.js";

export interface GreenVerificationInput {
  readonly targetObjectId: string;
  readonly workspaceId: string;
  readonly verdict: VerificationVerdictType;
  readonly microCorrectionHint: string | null;
  readonly necessaryPatch: string | null;
  readonly memory: Readonly<MemoryEntry>;
  readonly timestamp: string;
  readonly maxConsecutiveNoGo: number;
  readonly consecutiveNoGo: Map<string, number>;
  readonly consecutiveNoGoMaxEntries: number;
  readonly warn: GreenWarnPort;
  readonly generateObjectId: () => string;
  readonly dependencies: GreenServiceDependencies;
  readonly grant: (params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly basis: VerificationBasisType;
    readonly validUntil: string | null;
    readonly verifiedBy: VerifiedByType;
    readonly boundSurfaces?: readonly string[] | null;
    readonly boundScopeClass?: ScopeClass | null;
  }) => Promise<Readonly<GreenStatus>>;
  readonly pierce: (params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly reason: RevokeReasonType;
    readonly runId?: string;
  }) => Promise<Readonly<GreenStatus> | null>;
}

export async function runGreenVerification(
  input: GreenVerificationInput
): Promise<Readonly<VerificationResult>> {
  const currentCount = readConsecutiveNoGo(input.consecutiveNoGo, input.targetObjectId);
  let count = currentCount;
  let hint = input.microCorrectionHint;

  if (input.verdict === VerificationVerdict.NO_GO) {
    const noGoOutcome = await handleNoGoVerification(input, currentCount);
    count = noGoOutcome.count;
    hint = noGoOutcome.hint;
  } else {
    await handleGoVerification(input);
    count = 0;
  }

  const verificationResult = VerificationResultSchema.parse({
    runtime_id: input.generateObjectId(),
    object_kind: ControlPlaneObjectKind.VERIFICATION_RESULT,
    task_surface_ref: null,
    expires_at: null,
    derived_from: input.targetObjectId,
    retention_policy: "session_only",
    verdict: input.verdict,
    micro_correction_hint: hint,
    necessary_patch: input.necessaryPatch
  });
  const event = await input.dependencies.eventLogRepo.append({
    event_type: GreenGovernanceEventType.SOUL_VERIFICATION_COMPLETED,
    entity_type: "verification_result",
    entity_id: verificationResult.runtime_id,
    workspace_id: input.workspaceId,
    run_id: input.memory.run_id,
    caused_by: "system",
    payload_json: SoulVerificationCompletedPayloadSchema.parse({
      target_object_id: input.targetObjectId,
      verdict: verificationResult.verdict,
      micro_correction_hint: verificationResult.micro_correction_hint,
      consecutive_no_go_count: count,
      workspace_id: input.workspaceId,
      occurred_at: input.timestamp
    })
  });

  await input.dependencies.runtimeNotifier.notifyEntry(event);
  return verificationResult;
}

async function handleNoGoVerification(
  input: GreenVerificationInput,
  currentCount: number
): Promise<{ readonly count: number; readonly hint: string | null }> {
  if (currentCount >= input.maxConsecutiveNoGo) {
    return { count: input.maxConsecutiveNoGo, hint: "max retries reached" };
  }

  const count = currentCount + 1;
  writeConsecutiveNoGo({
    cache: input.consecutiveNoGo,
    targetObjectId: input.targetObjectId,
    count,
    maxEntries: input.consecutiveNoGoMaxEntries,
    warn: input.warn
  });
  await input.pierce({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    reason: RevokeReason.VERIFICATION_FAIL,
    runId: input.memory.run_id
  });

  return { count, hint: input.microCorrectionHint };
}

async function handleGoVerification(input: GreenVerificationInput): Promise<void> {
  input.consecutiveNoGo.delete(input.targetObjectId);
  const basis =
    input.memory.dimension === MemoryDimension.HAZARD
      ? VerificationBasis.USER_RECONFIRM
      : VerificationBasis.ACTIVE_VERIFICATION;
  await input.grant({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    basis,
    validUntil: calculateValidUntil(input.memory.dimension, input.timestamp),
    verifiedBy: determineVerifiedByForBasis(basis),
    boundSurfaces: input.memory.surface_id === null ? null : [input.memory.surface_id],
    boundScopeClass: input.memory.scope_class
  });
}
