import {
  GreenState,
  RevokeReason,
  type GreenStatus,
  type MemoryEntry,
  type RevokeReason as RevokeReasonType,
  type ScopeClass,
  type VerificationBasis as VerificationBasisType,
  type VerifiedBy as VerifiedByType
} from "@do-soul/alaya-protocol";

import { isExpired } from "../shared/time.js";
import {
  ACTIVE_LIFECYCLE,
  calculateGraceUntil,
  calculateValidUntil,
  determineReevaluationBasis,
  determineVerifiedByForBasis,
  type GreenServiceReevaluationOutcome
} from "./green-service-ports.js";

export interface GreenReevaluationInput {
  readonly targetObjectId: string;
  readonly workspaceId: string;
  readonly memory: Readonly<MemoryEntry>;
  readonly existing: Readonly<GreenStatus> | null;
  readonly nowIso: string;
  readonly runId?: string;
  readonly evaluatePiercingReason: (params: {
    readonly existing: Readonly<GreenStatus>;
    readonly memory: Readonly<MemoryEntry>;
    readonly workspaceId: string;
  }) => Promise<RevokeReasonType | null>;
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
  readonly setGrace: (params: {
    readonly targetObjectId: string;
    readonly workspaceId: string;
    readonly until: string;
    readonly runId?: string;
    readonly reason?: "valid_until_expired" | "manual";
  }) => Promise<Readonly<GreenStatus> | null>;
}

export async function reevaluateGreenStatus(
  input: GreenReevaluationInput
): Promise<GreenServiceReevaluationOutcome> {
  if (input.existing?.green_state === GreenState.GRACE && isExpired(input.existing.valid_until, input.nowIso)) {
    return await reevaluateExpiredGrace(input, input.existing);
  }

  if (input.existing?.green_state === GreenState.ELIGIBLE && isExpired(input.existing.valid_until, input.nowIso)) {
    return await reevaluateExpiredEligible(input);
  }

  const piercingOutcome = await reevaluatePiercing(input);
  if (piercingOutcome !== null) {
    return piercingOutcome;
  }

  if (input.existing?.green_state === GreenState.ELIGIBLE) {
    return "unchanged";
  }

  return await reevaluateGrant(input);
}

async function reevaluateExpiredGrace(
  input: GreenReevaluationInput,
  existing: Readonly<GreenStatus>
): Promise<GreenServiceReevaluationOutcome> {
  const pierced = await input.pierce({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    reason: RevokeReason.REVIEW_OVERDUE,
    runId: input.runId
  });
  return pierced === null || pierced.green_state === existing.green_state ? "unchanged" : "pierced";
}

async function reevaluateExpiredEligible(
  input: GreenReevaluationInput
): Promise<GreenServiceReevaluationOutcome> {
  const graceUntil = calculateGraceUntil(input.memory.dimension, input.nowIso);
  if (graceUntil === null) {
    return "unchanged";
  }

  const grace = await input.setGrace({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    until: graceUntil,
    runId: input.runId ?? input.memory.run_id,
    reason: "valid_until_expired"
  });
  return grace === null ? "unchanged" : "grace";
}

async function reevaluatePiercing(
  input: GreenReevaluationInput
): Promise<GreenServiceReevaluationOutcome | null> {
  const piercingReason =
    input.existing === null
      ? null
      : await input.evaluatePiercingReason({
          existing: input.existing,
          memory: input.memory,
          workspaceId: input.workspaceId
        });

  if (piercingReason === null) {
    return null;
  }

  const pierced = await input.pierce({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    reason: piercingReason,
    runId: input.runId
  });
  return pierced === null ? "unchanged" : "pierced";
}

async function reevaluateGrant(input: GreenReevaluationInput): Promise<GreenServiceReevaluationOutcome> {
  if (input.memory.lifecycle_state !== ACTIVE_LIFECYCLE || input.memory.evidence_refs.length === 0) {
    return "unchanged";
  }

  const basis = determineReevaluationBasis(input.memory, input.existing);
  if (basis === null) {
    return "unchanged";
  }

  await input.grant({
    targetObjectId: input.targetObjectId,
    workspaceId: input.workspaceId,
    basis,
    validUntil: calculateValidUntil(input.memory.dimension, input.nowIso),
    verifiedBy: determineVerifiedByForBasis(basis),
    boundSurfaces: input.memory.surface_id === null ? null : [input.memory.surface_id],
    boundScopeClass: input.memory.scope_class
  });

  return "granted";
}
