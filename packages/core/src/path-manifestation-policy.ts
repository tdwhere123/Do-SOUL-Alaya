import {
  DYNAMICS_CONSTANTS,
  ManifestationLevel,
  PathGovernanceClass,
  StabilityClass,
  type ManifestationLevel as ManifestationLevelValue,
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
// see also: manifestation-resolver.ts (consumer at recall time).
// see also: path-plasticity-service.ts (consumer at plasticity tick).

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
  // (recall-service.ts isPathGovernedForSuppression). A negative path's
  // recall_allowed must come only from its birth seed (a conflict llm-verdict),
  // never from reinforcement. Positive paths still promote via support_events
  // (Hebbian intent preserved). Stability/strength/lifecycle still evolve for
  // negative paths; only governance promotion is suppressed.
  // see also: path-plasticity-service.ts (PromotionPlan consumer),
  // recall-service.ts collectNegativePathSuppressions (suppression governance gate).
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
