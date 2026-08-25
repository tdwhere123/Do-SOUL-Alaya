import type { CoverAvailability } from "./binding-cover/composition.js";

export type SelectGammaRisk = "clear" | "blocked";
export type SelectGammaAuthority = "clear" | "blocked";

export type SelectGammaEligibilityInput = Readonly<{
  readonly candidate_key: string;
  readonly risk: SelectGammaRisk;
  readonly authority: SelectGammaAuthority;
}>;

export type SelectGammaQualityParts = Readonly<{
  readonly relevance: number;
  readonly temporal_fit: number;
}>;

export type SelectGammaAuthorityTieBreak =
  | "verified_user_assertion"
  | "verified_user_projection"
  | "unavailable";

export type SelectGammaQualityChannel =
  | Readonly<{ readonly status: "available"; readonly value: number }>
  | Readonly<{ readonly status: "unavailable" }>;

export type SelectGammaIdentityChannel =
  | Readonly<{ readonly status: "available"; readonly key: string }>
  | Readonly<{ readonly status: "unavailable" }>;

export type SelectGammaFormulaCandidate = Readonly<{
  readonly workspace_id: string;
  readonly candidate_key: string;
  readonly eligibility: Readonly<{
    readonly risk: SelectGammaRisk;
    readonly authority: SelectGammaAuthority;
  }>;
  readonly object_key: string;
  readonly dimension: string;
  readonly source: SelectGammaIdentityChannel;
  readonly lineage: SelectGammaIdentityChannel;
  readonly token_cost: number;
  readonly quality: number;
  readonly authority_tie_break: SelectGammaAuthorityTieBreak;
  readonly quality_channels: Readonly<{
    readonly temporal: SelectGammaQualityChannel;
  }>;
  readonly cover: Readonly<Record<string, number>>;
}>;

export type SelectGammaFeatureWeights = Readonly<Record<string, number>>;

export type SelectGammaIdentityPolicy = "source_hard_dedupe" | "object_only";

export type SelectGammaBinding = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly condition_digest: string;
  readonly candidates: readonly SelectGammaFormulaCandidate[];
  readonly feature_weights: SelectGammaFeatureWeights;
  readonly max_selected: number;
  readonly per_dimension_limits: Readonly<Record<string, number>> | null;
  readonly source_hard_dedupe?: boolean;
}>;

export type SelectGammaGainParts = Readonly<{
  readonly quality: number;
  readonly coverage: number;
  readonly cover_availability?: CoverAvailability;
}>;

export type SelectGammaWalkObjective<State = unknown> = Readonly<{
  readonly operator_id: string;
  readonly configuration_digest?: string;
  readonly createState: () => State;
  readonly cloneState?: (state: State) => State;
  readonly marginalGain: (
    candidate: SelectGammaFormulaCandidate,
    state: State
  ) => number;
  readonly accept: (
    candidate: SelectGammaFormulaCandidate,
    state: State
  ) => void;
  readonly decomposeGain?: (
    candidate: SelectGammaFormulaCandidate,
    state: State
  ) => SelectGammaGainParts;
}>;

export type SelectGammaRequest = Readonly<{
  readonly workspace_id: string;
  readonly generation_id: string;
  readonly condition_digest: string;
  readonly eligible_candidate_keys: readonly string[];
  readonly token_budget: number;
}>;

export type SelectGammaCoverState = Map<string, number>;

export type SelectGammaSelectionReceipt = Readonly<{
  readonly schema_version: 4;
  readonly objective_semantic_id: string;
  readonly configuration_digest: string | null;
  readonly source_hard_dedupe: boolean;
  readonly ordering_basis: "raw_marginal_gain" | "marginal_gain_per_token";
  readonly witness: Readonly<{
    readonly kind: "static_top_k_token_bound";
    readonly eligible_candidate_count: number;
    readonly k: number;
    readonly top_k_token_cost_upper_bound: number;
    readonly token_budget: number;
  }>;
}>;

export type SelectGammaDecisionReceipt =
  | Readonly<{
      readonly kind: "ineligible";
      readonly risk: SelectGammaRisk;
      readonly authority: SelectGammaAuthority;
    }>
  | Readonly<{
      readonly kind: "retained";
      readonly selected_count_before: number;
      readonly token_total_before: number;
      readonly token_estimate: number;
      readonly source: SelectGammaIdentityChannel;
      readonly lineage: SelectGammaIdentityChannel;
    }>
  | Readonly<{
      readonly kind: "duplicate";
      readonly identity_channel: "object" | "source";
      readonly retained_candidate_key: string;
    }>
  | Readonly<{
      readonly kind: "coverage_displaced" | "quality_displaced";
      readonly competing_candidate_key: string;
      readonly competing_marginal_gain: number;
      readonly candidate_marginal_gain: number;
    }>
  | Readonly<{
      readonly kind: "dimension_limit";
      readonly dimension: string;
      readonly accepted_before: number;
      readonly limit: number;
    }>
  | Readonly<{
      readonly kind: "max_entries";
      readonly accepted_before: number;
      readonly limit: number;
    }>
  | Readonly<{
      readonly kind: "max_total_tokens";
      readonly token_total_before: number;
      readonly token_estimate: number;
      readonly limit: number;
    }>;

export type SelectGammaDecision = Readonly<{
  readonly candidate_key: string;
  readonly selection_order: number;
  readonly selected_rank: number | null;
  readonly marginal_gain: number | null;
  readonly receipt: SelectGammaDecisionReceipt;
}>;

export type SelectGammaWalkResult = Readonly<{
  readonly selected_candidate_keys: readonly string[];
  readonly decisions: readonly SelectGammaDecision[];
  readonly selection_receipt: SelectGammaSelectionReceipt;
}>;
