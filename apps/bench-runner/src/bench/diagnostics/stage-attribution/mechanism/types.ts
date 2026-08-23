export const RECALL_MECHANISM_SPLIT_KIND = "recall_mechanism_split_v1" as const;
export const RECALL_MECHANISM_SPLIT_SCHEMA_VERSION = 1 as const;
export const MECHANISM_PREFIX_OPERATOR_ID = "recall_mechanism_prefix_eligibility_v1" as const;
export const GOLD_EXCLUSION_FIRST_REASONS = Object.freeze([
  "quality_displaced",
  "coverage_displaced",
  "duplicate_source",
  "duplicate_object",
  "dimension_limit",
  "token_budget",
  "entry_budget"
] as const);
export const GOLD_EXCLUSION_OUTCOMES = Object.freeze([
  "excluded",
  "admitted",
  "unavailable"
] as const);

export type GoldExclusionFirstReason = (typeof GOLD_EXCLUSION_FIRST_REASONS)[number];
export type UnavailableObservation = "unavailable";
export type MechanismQuestionIds = readonly string[] | UnavailableObservation;
export type GoldExclusionReason = GoldExclusionFirstReason | UnavailableObservation;
export type GoldExclusionOutcome = (typeof GOLD_EXCLUSION_OUTCOMES)[number];
export type PrefixEligibility = boolean | UnavailableObservation;

const FIRST_REASON_SET = new Set<string>(GOLD_EXCLUSION_FIRST_REASONS);

export function isGoldExclusionReason(value: unknown): value is GoldExclusionReason {
  return value === "unavailable" || FIRST_REASON_SET.has(value as string);
}

export function isGoldExclusionOutcome(value: unknown): value is GoldExclusionOutcome {
  return (GOLD_EXCLUSION_OUTCOMES as readonly string[]).includes(value as string);
}

export interface ControlTreatment<T> {
  readonly control: T;
  readonly treatment: T;
}

export interface GammaDecisionObservation {
  readonly kind: string;
  readonly reason?: string;
  readonly identity_channel?: "object" | "source" | "lineage";
}

export interface GoldMechanismObservation {
  readonly gold_key: string;
  readonly candidate_key?: string;
  readonly first_reason?: GoldExclusionReason;
  readonly prefix_eligible?: PrefixEligibility;
  readonly delivered_hit?: ControlTreatment<boolean>;
  readonly field_member?: ControlTreatment<boolean>;
  readonly compatibility?: ControlTreatment<boolean>;
  readonly binding_solutions?: ControlTreatment<readonly string[]>;
  readonly activation?: ControlTreatment<number>;
  readonly fused_rank?: ControlTreatment<number | null>;
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly gamma_decision?: ControlTreatment<GammaDecisionObservation>;
  readonly rank_after_fusion?: number | null;
  readonly rank_after_feature_rerank?: number | null;
  readonly rank_after_coverage_selector?: number | null;
}

export interface PrefixCandidateObservation {
  readonly candidate_key: string;
  readonly prefix_eligible?: PrefixEligibility;
}

export interface MechanismQuestionObservation {
  readonly question_id: string;
  readonly delivered_hit?: ControlTreatment<boolean>;
  readonly field_member?: ControlTreatment<boolean>;
  readonly compatibility?: ControlTreatment<boolean>;
  readonly binding_solutions?: ControlTreatment<readonly string[]>;
  readonly activation?: ControlTreatment<number>;
  readonly fused_rank?: ControlTreatment<number | null>;
  readonly fused_in_top5?: ControlTreatment<boolean>;
  readonly gamma_decision?: ControlTreatment<GammaDecisionObservation>;
  readonly golds?: readonly GoldMechanismObservation[];
  readonly candidates?: readonly PrefixCandidateObservation[];
}

export interface RecallMechanismSplitInput {
  readonly questions: readonly MechanismQuestionObservation[];
}

export interface GoldExclusionRow {
  readonly question_id: string;
  readonly gold_key: string;
  readonly first_reason: GoldExclusionReason;
  readonly outcome: GoldExclusionOutcome;
}

export interface PrefixEligibilityRow {
  readonly question_id: string;
  readonly candidate_key: string;
  readonly eligible: PrefixEligibility;
}

export interface RecallMechanismSplitReceipt {
  readonly schema_version: 1;
  readonly kind: typeof RECALL_MECHANISM_SPLIT_KIND;
  readonly prefix_operator_id: typeof MECHANISM_PREFIX_OPERATOR_ID;
  readonly questions: readonly MechanismQuestionObservation[];
  readonly field_member_added: MechanismQuestionIds;
  readonly compatibility_added: MechanismQuestionIds;
  readonly binding_solution_added: MechanismQuestionIds;
  readonly activation_changed: MechanismQuestionIds;
  readonly fused_rank_changed: MechanismQuestionIds;
  readonly gamma_admission_changed: MechanismQuestionIds;
  readonly delivered_hit_changed: MechanismQuestionIds;
  readonly gold_exclusions: readonly GoldExclusionRow[];
  readonly bounded_candidate_prefix: readonly PrefixEligibilityRow[];
}
