/** Near-top opportunity is an attribution stage, not a mechanism. */
export type AttributionStage =
  | "write_or_unevaluable"
  | "raw_pool_absent"
  | "pre_waist_prune"
  | "waist_composition"
  | "coverage_or_budget"
  | "near_top_final_order"
  | "delivered_top5";

/**
 * Causal owner among waist-present misses; never substitutes for opportunity.
 * `honest_higher_r_obj` means every delivered top-5 occupier legally outranks
 * the gold on family-max R_obj — no Gamma reorder or composition to blame.
 */
export type AttributionMechanism =
  | "composition"
  | "coverage_admission"
  | "residual_order"
  | "honest_higher_r_obj"
  | null;

export type StageCountKey = AttributionStage;

export interface StageAttributionDenominators {
  readonly D_Q_evaluated: number;
  readonly D_Q_scorable: number;
  readonly D_Q_gold_bearing: number;
  readonly D_Q_miss: number;
  readonly D_G_all: number;
}

export interface CandidateAbsenceViews {
  readonly miss_taxonomy_candidate_absent: {
    readonly count: number;
    readonly denominator: number;
    readonly denominator_name: "D_Q_miss";
    readonly question_ids: readonly string[];
  };
  readonly quality_candidate_absent_count: {
    readonly count: number;
    readonly denominator: number;
    readonly denominator_name: "D_Q_scorable";
    readonly question_ids: readonly string[];
  };
  readonly rank_bucket_candidate_absent: {
    readonly count: number;
    readonly denominator: number;
    readonly denominator_name: "D_Q_gold_bearing";
    readonly question_ids: readonly string[];
  };
}

export interface GoldObjectStageRow {
  readonly question_id: string;
  readonly object_id: string;
  readonly object_kind: string;
  readonly stage: AttributionStage;
  readonly mechanism: AttributionMechanism;
  readonly opportunity_pre_budget_6_10: boolean;
  readonly miss_taxonomy: string | null;
  readonly pool_rank: number | null;
  readonly final_rank: number | null;
  readonly proof: string;
  readonly near_top_class?: "honest_higher_r_obj" | null;
  readonly gold_family_max?: number | null;
  readonly rank5_family_max?: number | null;
}

export interface QuestionStageRow {
  readonly question_id: string;
  readonly stage: AttributionStage;
  readonly mechanism: AttributionMechanism;
  readonly opportunity_pre_budget_6_10: boolean;
  readonly miss_taxonomy: string | null;
  readonly best_pool_rank: number | null;
  readonly hit_at_5: boolean;
  readonly proof: string;
}

export interface StageAttributionSummary {
  readonly denominators: StageAttributionDenominators;
  readonly question_stage_counts: Readonly<Record<StageCountKey, number>>;
  readonly gold_stage_counts: Readonly<Record<StageCountKey, number>>;
  readonly kpi_pre_budget_6_10: number;
  readonly delivery_order_drop: number;
  readonly candidate_absence_views: CandidateAbsenceViews;
  readonly not_checked: readonly string[];
}

export interface StageAttributionTables {
  readonly schema_version: 1;
  readonly kind: "stage-attribution-tables";
  readonly cell: string;
  readonly source_diagnostics: string;
  readonly summary: StageAttributionSummary;
  readonly questions: readonly QuestionStageRow[];
  readonly gold_objects: readonly GoldObjectStageRow[];
}

export const STAGE_COUNT_KEYS: readonly StageCountKey[] = [
  "write_or_unevaluable",
  "raw_pool_absent",
  "pre_waist_prune",
  "waist_composition",
  "coverage_or_budget",
  "near_top_final_order",
  "delivered_top5"
] as const;

export function emptyStageCounts(): Record<StageCountKey, number> {
  return {
    write_or_unevaluable: 0,
    raw_pool_absent: 0,
    pre_waist_prune: 0,
    waist_composition: 0,
    coverage_or_budget: 0,
    near_top_final_order: 0,
    delivered_top5: 0
  };
}

export function stageCountKey(stage: AttributionStage): StageCountKey {
  return stage;
}
