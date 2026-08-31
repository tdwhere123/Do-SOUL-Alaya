import {
  ScopeClass,
  ToolGovernanceDecisionSchema,
  type ClaimForm,
  type Slot,
  type ToolGovernanceDecision,
  type ToolGovernancePort,
  type ToolGovernanceQuery
} from "@do-soul/alaya-protocol";

const GOVERNED_CLAIM_STATUSES = new Set<ClaimForm["claim_status"]>(["active", "contested", "winner"]);

export interface SoulStructureRegistryReader {
  listClaimsForProject(projectRef: string): Promise<readonly Readonly<ClaimForm>[]>;
  listSlotsForProject(projectRef: string): Promise<readonly Readonly<Slot>[]>;
}

/**
 * Implements ToolGovernancePort by querying the SOUL structure registration layer.
 * Read-only: must not mutate any soul state.
 */
export class SoulToolGovernanceAdapter implements ToolGovernancePort {
  public readonly kind = "soul-governance-adapter";

  public constructor(private readonly reader: SoulStructureRegistryReader) {}

  public async queryToolGovernance(query: ToolGovernanceQuery): Promise<ToolGovernanceDecision> {
    const canonicalKey = query.governance_subject.canonical_key;
    const projectRef = query.request_context.project_ref;
    const allowedScopeClasses = resolveAllowedScopeClasses(query);
    const [claims, slots] = await Promise.all([
      this.reader.listClaimsForProject(projectRef),
      this.reader.listSlotsForProject(projectRef)
    ]);
    const matchedClaims = claims.filter(
      (claim) =>
        GOVERNED_CLAIM_STATUSES.has(claim.claim_status) &&
        claim.governance_subject.canonical_key === canonicalKey &&
        allowedScopeClasses.has(claim.scope_class)
    );
    const matchedSlots = slots.filter(
      (slot) =>
        slot.governance_subject.canonical_key === canonicalKey &&
        allowedScopeClasses.has(slot.scope_class)
    );
    const matchedClaimRefs = matchedClaims.map((claim) => claim.object_id);
    const matchedSlotRefs = matchedSlots.map((slot) => slot.object_id);
    const matchedClaimById = new Map(matchedClaims.map((claim) => [claim.object_id, claim] as const));
    const strictWinningClaims = matchedSlots.flatMap((slot) => {
      if (slot.winner_claim_id === null) {
        return [];
      }

      const winnerClaim = matchedClaimById.get(slot.winner_claim_id);
      return winnerClaim !== undefined && winnerClaim.enforcement_level === "strict"
        ? [winnerClaim]
        : [];
    });
    const strictMatchedClaimsWithoutSlotWinner = matchedClaims.filter(
      (claim) =>
        claim.enforcement_level === "strict" &&
        !matchedSlots.some((slot) => slot.winner_claim_id === claim.object_id)
    );
    const hardConstraintsPresent =
      strictWinningClaims.length > 0 ||
      (matchedSlots.length === 0 && strictMatchedClaimsWithoutSlotWinner.length > 0);
    const hasContestedClaim = matchedClaims.some((claim) => claim.claim_status === "contested");
    const hasProcedureClaim = matchedClaims.some((claim) => claim.claim_kind === "procedure");
    const hasExceptionClaim = matchedClaims.some((claim) => claim.claim_kind === "exception");
    const hasUnresolvedSlot = matchedSlots.some((slot) => slot.winner_claim_id === null);
    const requiresRedCard = hardConstraintsPresent && (query.destructive || query.scope_guard === "global");

    const finalResult = requiresRedCard
      ? "deny"
      : hardConstraintsPresent || hasContestedClaim || hasProcedureClaim || hasExceptionClaim || hasUnresolvedSlot
        ? "ask"
        : "allow";

    return ToolGovernanceDecisionSchema.parse({
      final_result: finalResult,
      matched_claim_refs: matchedClaimRefs,
      matched_slot_refs: matchedSlotRefs,
      hard_constraints_present: hardConstraintsPresent,
      requires_red_card: requiresRedCard,
      explanation_summary: buildExplanationSummary({
        canonicalKey,
        matchedClaimCount: matchedClaimRefs.length,
        matchedSlotCount: matchedSlotRefs.length,
        requiresRedCard,
        hardConstraintsPresent,
        hasContestedClaim,
        hasProcedureClaim,
        hasExceptionClaim,
        hasUnresolvedSlot
      })
    });
  }
}

function buildExplanationSummary(input: {
  readonly canonicalKey: string;
  readonly matchedClaimCount: number;
  readonly matchedSlotCount: number;
  readonly requiresRedCard: boolean;
  readonly hardConstraintsPresent: boolean;
  readonly hasContestedClaim: boolean;
  readonly hasProcedureClaim: boolean;
  readonly hasExceptionClaim: boolean;
  readonly hasUnresolvedSlot: boolean;
}): string {
  const prefix = `Matched ${input.matchedClaimCount} claims and ${input.matchedSlotCount} slots for ${input.canonicalKey}:`;

  if (input.requiresRedCard) {
    return `${prefix} strict governance structure requires a red card for destructive or global access.`;
  }

  if (input.hardConstraintsPresent) {
    return `${prefix} strict matched claims require confirmation before execution.`;
  }

  if (input.hasContestedClaim) {
    return `${prefix} contested matched claims require confirmation before execution.`;
  }

  if (input.hasProcedureClaim || input.hasExceptionClaim) {
    return `${prefix} matched procedure or exception claims require confirmation before execution.`;
  }

  if (input.hasUnresolvedSlot) {
    return `${prefix} matched slots do not yet have a winner and require confirmation before execution.`;
  }

  return `${prefix} no strict, contested, procedure, exception, or unresolved matched structure blocks the request.`;
}

function resolveAllowedScopeClasses(query: ToolGovernanceQuery): ReadonlySet<ClaimForm["scope_class"]> {
  return query.scope_guard === "global"
    ? new Set<ClaimForm["scope_class"]>([ScopeClass.GLOBAL_DOMAIN, ScopeClass.GLOBAL_CORE])
    : new Set<ClaimForm["scope_class"]>([ScopeClass.PROJECT]);
}
