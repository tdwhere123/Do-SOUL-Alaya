// @ts-nocheck
import type { LongMemEvalQuestionDiagnostic } from
  "../../../diagnostics/schema/diagnostics-types.js";

export function baseQuestion(
  overrides: Partial<LongMemEvalQuestionDiagnostic> & {
    readonly question_id: string;
  }
): LongMemEvalQuestionDiagnostic {
  return {
    question_id: overrides.question_id,
    question_type: null,
    is_abstention: false,
    premise_invalid: false,
    round_index: null,
    gold_memory_ids: overrides.gold_memory_ids ?? [],
    gold_evidence_ids: [],
    gold_object_ids: overrides.gold_object_ids ?? overrides.gold_memory_ids ?? [],
    answer_session_ids: ["s1"],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "under_ranked",
    miss_taxonomy: null,
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: ["candidates"],
    provider_state: "provider_not_requested",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_pool_complete: true,
    candidate_pool_count: 0,
    fine_pruned_count: 0,
    fine_assessment_pruned_candidates: [],
    candidates: [],
    candidate_key_collisions: [],
    gold: [],
    ...overrides
  } as LongMemEvalQuestionDiagnostic;
}
