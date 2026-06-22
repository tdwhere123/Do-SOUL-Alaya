import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics.js";

/** A delivered top-1 gold diagnostic; override any field per case. */
export const buildGoldDiagnostic = (
  overrides: Partial<Record<string, unknown>> & { object_id: string }
) => ({
  candidate_status: "delivered" as const,
  final_rank: 1,
  active_constraint_rank: null,
  pre_budget_rank: 1,
  selection_order: 1,
  fused_rank: 1,
  fused_score: 0.5,
  per_stream_rank: null,
  fused_rank_contribution_per_stream: null,
  plane_first_admitted: null,
  plane_winning_admission: null,
  source_planes: [] as readonly string[],
  lexical_rank: null,
  structural_score: null,
  score_factors: null,
  source_channels: [] as readonly string[],
  budget_drop_reason: null,
  ...overrides
});

/** A minimal hit_at_5 question diagnostic wrapping the given golds. */
export const buildQuestionDiagnosticFixture = (input: {
  readonly questionId?: string;
  readonly gold: ReadonlyArray<ReturnType<typeof buildGoldDiagnostic>>;
}) =>
  ({
    question_id: input.questionId ?? "q-fixture",
    round_index: null,
    gold_memory_ids: input.gold.map((g) => g.object_id),
    answer_session_ids: ["session-a"],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: true,
    hit_at_5: true,
    hit_at_10: true,
    miss_classification: "hit_at_5" as const,
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "disabled" as const,
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0] as const,
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_key_collisions: [],
    gold: input.gold
  }) as unknown as LongMemEvalQuestionDiagnostic;
