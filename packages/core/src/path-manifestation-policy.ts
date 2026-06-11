import {
  DYNAMICS_CONSTANTS,
  ManifestationLevel,
  ManifestationState,
  PathGovernanceClass,
  StabilityClass,
  type ManifestationLevel as ManifestationLevelValue,
  type ManifestationState as ManifestationStateValue,
  type PathGovernanceClass as PathGovernanceClassValue,
  type PathRelation,
  type StabilityClass as StabilityClassValue
} from "@do-soul/alaya-protocol";

// invariant: PathManifestationPolicy is the pure, dependency-free authority
// matrix that maps `governance_class` to the set of manifestation levels a
// caller may take, and the cumulative-evidence thresholds that drive
// `stability_class` evolution + governance promotion.
//
// The matrix encodes the visibility/auditability gradient:
//   - lens_entry        -> visible to user, lowest governance bar
//   - dialogue_nudge    -> agent dialogue context, medium bar
//   - stance_bias       -> silently biases agent stance, highest bar
//
// see also: packages/core/src/manifestation-resolver.ts:ManifestationResolver.
// see also: packages/core/src/path-plasticity/service.ts:PathPlasticityService.

const MANIFESTATION_AUTHORITY: Readonly<
  Record<PathGovernanceClassValue, ReadonlySet<ManifestationLevelValue>>
> = Object.freeze({
  [PathGovernanceClass.HINT_ONLY]: new Set<ManifestationLevelValue>(),
  [PathGovernanceClass.ATTENTION_ONLY]: new Set<ManifestationLevelValue>([
    ManifestationLevel.LENS_ENTRY
  ]),
  [PathGovernanceClass.RECALL_ALLOWED]: new Set<ManifestationLevelValue>([
    ManifestationLevel.LENS_ENTRY,
    ManifestationLevel.DIALOGUE_NUDGE
  ]),
  [PathGovernanceClass.STRICTLY_GOVERNED]: new Set<ManifestationLevelValue>([
    ManifestationLevel.LENS_ENTRY,
    ManifestationLevel.DIALOGUE_NUDGE,
    ManifestationLevel.STANCE_BIAS
  ])
});

export interface ManifestationAuthority {
  readonly governance_class: PathGovernanceClassValue;
  readonly authorised_levels: readonly ManifestationLevelValue[];
}

export function manifestationAuthorityFor(
  governance: PathGovernanceClassValue
): ManifestationAuthority {
  return Object.freeze({
    governance_class: governance,
    authorised_levels: Object.freeze([...MANIFESTATION_AUTHORITY[governance]])
  });
}

export function governanceAuthorisesLevel(
  governance: PathGovernanceClassValue,
  level: ManifestationLevelValue
): boolean {
  return MANIFESTATION_AUTHORITY[governance].has(level);
}

// Returns the highest-visibility level that BOTH (a) is <= desiredLevel in the
// resolver's fallback ordering and (b) is authorised by the governance ceiling.
// Returns null when no authorised level exists (hint_only).
export function clampLevelByGovernance(
  desiredLevel: ManifestationLevelValue,
  governance: PathGovernanceClassValue,
  fallbackOrder: readonly ManifestationLevelValue[]
): ManifestationLevelValue | null {
  const authorised = MANIFESTATION_AUTHORITY[governance];
  if (authorised.size === 0) {
    return null;
  }
  for (const level of fallbackOrder) {
    if (level === desiredLevel || isLowerInOrder(level, desiredLevel, fallbackOrder)) {
      if (authorised.has(level)) {
        return level;
      }
    }
  }
  return null;
}

function isLowerInOrder(
  candidate: ManifestationLevelValue,
  reference: ManifestationLevelValue,
  fallbackOrder: readonly ManifestationLevelValue[]
): boolean {
  const candidateIndex = fallbackOrder.indexOf(candidate);
  const referenceIndex = fallbackOrder.indexOf(reference);
  if (candidateIndex < 0 || referenceIndex < 0) {
    return false;
  }
  return candidateIndex > referenceIndex;
}

// invariant: governance_class is a HARD CEILING on recall memory
// manifestation. A recalled memory's delivered manifestation is
// min(strengthTier, governanceCeiling) — the gate may only LOWER, never
// elevate. This is the memory-level twin of the path-level
// MANIFESTATION_AUTHORITY gradient above; both live here so the memory
// ceiling and the path ceiling cannot drift apart.
// see also: recall-candidate-builder.ts (clamp site),
//   recall-service.ts collectSupplementaryData (per-memory ceiling map).

// Strict manifestation ordering hidden < hint < excerpt < full_eligible.
// Index position is the band rank; the clamp returns the lower-ranked band.
const MEMORY_MANIFESTATION_ORDER: readonly ManifestationStateValue[] = [
  ManifestationState.HIDDEN,
  ManifestationState.HINT,
  ManifestationState.EXCERPT,
  ManifestationState.FULL_ELIGIBLE
];

// Maps each PathGovernanceClass band to the most permissive ManifestationState
// it authorises, mirroring the MANIFESTATION_AUTHORITY gradient:
//   hint_only         -> hint        (lowest visibility band; cf. ATTENTION_ONLY
//                                      authorises only lens_entry, hint_only none)
//   attention_only    -> excerpt
//   recall_allowed    -> full_eligible
//   strictly_governed -> full_eligible (highest trust; never throttles content)
// The PathGovernanceClass enum has exactly these four members
// (packages/protocol/src/soul/path-relation.ts pathGovernanceClassValues);
// no additional bands exist, so no conservative fallback is needed.
const GOVERNANCE_MANIFESTATION_CEILING: Readonly<
  Record<PathGovernanceClassValue, ManifestationStateValue>
> = Object.freeze({
  [PathGovernanceClass.HINT_ONLY]: ManifestationState.HINT,
  [PathGovernanceClass.ATTENTION_ONLY]: ManifestationState.EXCERPT,
  [PathGovernanceClass.RECALL_ALLOWED]: ManifestationState.FULL_ELIGIBLE,
  [PathGovernanceClass.STRICTLY_GOVERNED]: ManifestationState.FULL_ELIGIBLE
});

// invariant: the manifestation CEILING must trust recall_allowed only when it
// is grounded in TRUSTED PROVENANCE, never the live plasticity-promoted band.
// A POSITIVE path's governance_class is agent-pumpable: evolveGovernanceClass
// auto-promotes attention_only -> recall_allowed at support_events_count >= 8,
// and support_events_count is driven by agent-supplied report_context_usage
// "used" receipts (positive promotion is intentionally OPEN for Hebbian recall
// WEIGHTING). If the content-visibility ceiling consumed that promoted band
// directly, an agent could pump ~8 reported-used turns and lift a victim
// memory's ceiling from excerpt to full_eligible, over-surfacing preview
// content. So a recall_allowed reached via auto-promotion (whose legitimacy
// .evidence_basis still carries only its BIRTH marker — plasticity rewrites
// governance_class but never evidence_basis) contributes at most EXCERPT (the
// attention_only band) to the ceiling. Only a recall_allowed BORN at that band
// with a trusted-provenance marker contributes full_eligible.
//
// Trusted recall_allowed-birth markers (the ONLY producers that mint a POSITIVE
// recall-eligible path directly at recall_allowed):
//   - signal_graph_reference
//     (packages/core/src/path-relation-proposal-service.ts:SIGNAL_GRAPH_REF_SEED_PROFILE)
//   - edge_proposal_accept:<id>
//     (packages/core/src/edge-proposal-service.ts:EdgeProposalService.acceptProposal)
// strictly_governed is user/operator-set, not auto-reachable, so it keeps
// full_eligible regardless of evidence_basis. The recall-WEIGHTING use of the
// promoted band (graph_support / plasticity) is unaffected — only the
// manifestation ceiling's trust source is narrowed here.
// see also: packages/core/src/path-manifestation-policy.ts:evolveGovernanceClass.
// see also: packages/core/src/path-relation-proposal-service.ts:SIGNAL_GRAPH_REF_SEED_PROFILE.
// see also: packages/core/src/edge-proposal-service.ts:EdgeProposalService.acceptProposal.
// see also: packages/core/src/path-plasticity/helpers.ts:buildUpdatesWithPromotion.
const TRUSTED_RECALL_ALLOWED_EVIDENCE_MARKERS: ReadonlySet<string> =
  new Set<string>(["signal_graph_reference"]);
const TRUSTED_RECALL_ALLOWED_EVIDENCE_PREFIXES: readonly string[] = Object.freeze([
  "edge_proposal_accept:"
]);

function recallAllowedHasTrustedProvenance(
  evidenceBasis: readonly string[]
): boolean {
  for (const marker of evidenceBasis) {
    if (TRUSTED_RECALL_ALLOWED_EVIDENCE_MARKERS.has(marker)) {
      return true;
    }
    for (const prefix of TRUSTED_RECALL_ALLOWED_EVIDENCE_PREFIXES) {
      if (marker.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

// A single inbound recall-eligible path's contribution to the memory ceiling.
// evidence_basis is the path's BIRTH provenance (set at mint, preserved across
// plasticity promotion), used to distinguish a trusted-born recall_allowed from
// an auto-promoted one.
export interface PathGovernanceContribution {
  readonly governance_class: PathGovernanceClassValue;
  readonly evidence_basis: readonly string[];
}

// invariant: a memory governed by MULTIPLE inbound recall-eligible paths takes
// the MOST PERMISSIVE ceiling among their (trust-adjusted) bands — a strong
// association is not throttled by a weak co-existing one. An empty contribution
// set (no governing inbound path) returns full_eligible: the ceiling never
// silently suppresses an ordinary ungoverned memory, it only lowers when a
// governing path demands it. A recall_allowed contribution WITHOUT trusted
// provenance is treated as attention_only (excerpt) so the agent-pumpable
// auto-promotion ladder cannot raise the ceiling above excerpt.
export function memoryGovernanceCeiling(
  contributions: readonly PathGovernanceContribution[]
): ManifestationStateValue {
  let ceiling: ManifestationStateValue = ManifestationState.HIDDEN;
  let sawAny = false;
  for (const contribution of contributions) {
    sawAny = true;
    const band = ceilingBandForContribution(contribution);
    if (manifestationRank(band) > manifestationRank(ceiling)) {
      ceiling = band;
    }
  }
  return sawAny ? ceiling : ManifestationState.FULL_ELIGIBLE;
}

function ceilingBandForContribution(
  contribution: PathGovernanceContribution
): ManifestationStateValue {
  if (
    contribution.governance_class === PathGovernanceClass.RECALL_ALLOWED &&
    !recallAllowedHasTrustedProvenance(contribution.evidence_basis)
  ) {
    // Untrusted (auto-promoted) recall_allowed: cap its contribution at the
    // attention_only band so a pumped support ladder cannot exceed excerpt.
    return GOVERNANCE_MANIFESTATION_CEILING[PathGovernanceClass.ATTENTION_ONLY];
  }
  return GOVERNANCE_MANIFESTATION_CEILING[contribution.governance_class];
}

// invariant: fail-CLOSED ceiling band for a TRANSIENT governance-read failure.
// When the per-recall governing-path lookup THROWS (a transient path-store read
// error), the ceiling cannot be computed, but it must NOT silently vanish: an
// absent ceiling defaults to full_eligible (unrestricted), which would lift
// every governed memory to its full strength tier on a read blip. So a thrown
// lookup caps EVERY candidate in that recall to this safe band until governance
// can be read again. The safe band is HINT, the LOWEST non-hidden visibility
// band: hint is the only band that is never an over-surface for ANY governance
// class — hint_only (true ceiling hint), attention_only, recall_allowed, and
// strictly_governed all permit at least hint, so capping to hint cannot exceed
// any class's true ceiling on a read failure. A higher failsafe (e.g. excerpt)
// would over-surface a hint_only-governed memory: at the lens a hint renders a
// bare `[memory ref: <id>]` (zero body) while excerpt serves a body fragment
// (context-lens-assembler.ts resolveContentSnapshot), so excerpt-on-throw leaks
// preview content for a memory whose true ceiling is hint. Recall still
// returns/scores/ranks every memory; only the delivered surface is conserved to
// a bare ref until governance can be read — the correct conservative tradeoff
// for a HARD ceiling. This is distinct from a missing pathExpansionPort
// (governance plane not deployed) which legitimately stays open (full_eligible).
// see also: recall-service.ts collectGovernanceCeilings (throw vs absent branch),
//   context-lens-assembler.ts resolveContentSnapshot (hint = bare ref, excerpt = body).
export const GOVERNANCE_CEILING_FAILSAFE_BAND: ManifestationStateValue =
  ManifestationState.HINT;

// invariant: pure, total min over the strict ordering
// hidden < hint < excerpt < full_eligible. Returns the LOWER band, so the
// governance ceiling can only cap (never elevate) the strength tier.
export function clampManifestationByGovernance(
  tier: ManifestationStateValue,
  ceiling: ManifestationStateValue
): ManifestationStateValue {
  return manifestationRank(tier) <= manifestationRank(ceiling) ? tier : ceiling;
}

function manifestationRank(state: ManifestationStateValue): number {
  // indexOf is total: every ManifestationState member is in the order array,
  // so a -1 (would sort below hidden) is unreachable for valid enum inputs.
  return MEMORY_MANIFESTATION_ORDER.indexOf(state);
}

// Stability evolution thresholds. The protocol dynamics constants are the
// single source for cumulative support count gates.
export const STABILITY_PROMOTION_THRESHOLDS = Object.freeze({
  volatile_to_normal_support_count: DYNAMICS_CONSTANTS.path_plasticity.volatile_to_normal_support_count,
  normal_to_stable_support_count: DYNAMICS_CONSTANTS.path_plasticity.normal_to_stable_support_count
} as const);

// Governance promotion thresholds. Spec: hint_only -> attention_only after
// support_events_count >= 3 with contradiction_events_count == 0;
// attention_only -> recall_allowed after support_events_count >= 8.
// strictly_governed stays user-set and is never auto-demoted/promoted.
export const GOVERNANCE_PROMOTION_THRESHOLDS = Object.freeze({
  hint_to_attention_support_count: 3,
  attention_to_recall_support_count: 8
} as const);

export interface StabilityEvolutionInput {
  readonly current: StabilityClassValue;
  readonly governance_class: PathGovernanceClassValue;
  readonly support_events_count: number;
}

// Evolves stability_class along volatile -> normal -> stable -> pinned.
// Returns the input class when no threshold is crossed. `pinned` is only
// reachable when governance_class === strictly_governed.
export function evolveStabilityClass(input: StabilityEvolutionInput): StabilityClassValue {
  const supportCount = input.support_events_count;
  let next: StabilityClassValue = input.current;

  if (
    next === StabilityClass.VOLATILE &&
    supportCount >= STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count
  ) {
    next = StabilityClass.NORMAL;
  }
  if (
    next === StabilityClass.NORMAL &&
    supportCount >= STABILITY_PROMOTION_THRESHOLDS.normal_to_stable_support_count
  ) {
    next = StabilityClass.STABLE;
  }
  if (next === StabilityClass.STABLE && input.governance_class === PathGovernanceClass.STRICTLY_GOVERNED) {
    next = StabilityClass.PINNED;
  }
  return next;
}

export interface GovernanceEvolutionInput {
  readonly current: PathGovernanceClassValue;
  readonly support_events_count: number;
  readonly contradiction_events_count: number;
}

// Returns the next governance_class along the auto-promotion ladder.
// strictly_governed is user-set and never auto-promoted/demoted.
// Promotions require ZERO contradictions; any contradiction halts the ladder.
export function evolveGovernanceClass(
  input: GovernanceEvolutionInput
): PathGovernanceClassValue {
  if (input.current === PathGovernanceClass.STRICTLY_GOVERNED) {
    return input.current;
  }
  if (input.contradiction_events_count > 0) {
    return input.current;
  }

  let next: PathGovernanceClassValue = input.current;
  if (
    next === PathGovernanceClass.HINT_ONLY &&
    input.support_events_count >= GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count
  ) {
    next = PathGovernanceClass.ATTENTION_ONLY;
  }
  if (
    next === PathGovernanceClass.ATTENTION_ONLY &&
    input.support_events_count >= GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count
  ) {
    next = PathGovernanceClass.RECALL_ALLOWED;
  }
  return next;
}

export interface PromotionPlanStep {
  readonly kind: "stability_promotion" | "governance_promotion";
  readonly path_id: string;
  readonly previous: PathGovernanceClassValue | StabilityClassValue;
  readonly next: PathGovernanceClassValue | StabilityClassValue;
  readonly support_events_count: number;
  readonly contradiction_events_count: number;
}

export interface PromotionPlan {
  readonly stability: PromotionPlanStep | null;
  readonly governance: PromotionPlanStep | null;
}

export interface PlanPromotionInput {
  readonly path: Readonly<PathRelation>;
  readonly nextSupportEventsCount: number;
  readonly nextContradictionEventsCount: number;
}

// Computes the promotion plan-step pair for a single path given its post-tick
// support / contradiction counts. Either step may be null if no promotion
// crosses a threshold this tick.
export function planPromotion(input: PlanPromotionInput): PromotionPlan {
  const path = input.path;
  const currentStability = path.plasticity_state.stability_class;
  const currentGovernance = path.legitimacy.governance_class;

  // invariant: negative paths (effect_vector.recall_bias < 0) never gain
  // governance_class through plasticity. The support-events ladder is
  // agent-pumpable (report_context_usage co-usage receipts drive
  // support_events_count with no sign filter), so without this guard an agent
  // could seed an attention_only negative, pump support >= 8, auto-promote it
  // to recall_allowed, and clear the suppression governance gate
  // (packages/core/src/recall-service.ts:collectNegativePathSuppressions). A negative path's
  // recall_allowed must come only from its birth seed (a conflict llm-verdict),
  // never from reinforcement. Positive paths still promote via support_events
  // (Hebbian intent preserved). Stability/strength/lifecycle still evolve for
  // negative paths; only governance promotion is suppressed.
  // see also: packages/core/src/path-plasticity/service.ts:PathPlasticityService.planDeltasForPath.
  // see also: packages/core/src/recall-service.ts:collectNegativePathSuppressions.
  const governanceLadderAllowed = path.effect_vector.recall_bias >= 0;
  const nextGovernance = governanceLadderAllowed
    ? evolveGovernanceClass({
        current: currentGovernance,
        support_events_count: input.nextSupportEventsCount,
        contradiction_events_count: input.nextContradictionEventsCount
      })
    : currentGovernance;

  const nextStability = evolveStabilityClass({
    current: currentStability,
    governance_class: nextGovernance,
    support_events_count: input.nextSupportEventsCount
  });

  return Object.freeze({
    stability:
      nextStability === currentStability
        ? null
        : Object.freeze({
            kind: "stability_promotion" as const,
            path_id: path.path_id,
            previous: currentStability,
            next: nextStability,
            support_events_count: input.nextSupportEventsCount,
            contradiction_events_count: input.nextContradictionEventsCount
          }),
    governance:
      nextGovernance === currentGovernance
        ? null
        : Object.freeze({
            kind: "governance_promotion" as const,
            path_id: path.path_id,
            previous: currentGovernance,
            next: nextGovernance,
            support_events_count: input.nextSupportEventsCount,
            contradiction_events_count: input.nextContradictionEventsCount
          })
  });
}
