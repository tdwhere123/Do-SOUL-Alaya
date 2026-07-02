import { describe, expect, it } from "vitest";

import { BenchRecallDiagnosticsSchema } from "../../harness/recall-diagnostics-schema.js";

import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../longmemeval/diagnostics-schema.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  summarizeLongMemEvalRecallEvidence,
  type LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

const emptyQueryProbes = {
  object_ids: [],
  subject_hints: [],
  evidence_refs: [],
  run_ids: [],
  surface_ids: [],
  file_paths: [],
  command_names: [],
  package_names: [],
  task_refs: [],
  dimensions: [],
  scope_classes: [],
  domain_tags: [],
  lexical_terms: [],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
};

describe("per-gold rank buckets and displaced-by attribution", () => {
  const buildGold = (
    overrides: Partial<Record<string, unknown>> & { object_id: string }
  ) => ({
    candidate_status: "delivered" as const,
    final_rank: 1 as number | null,
    active_constraint_rank: null,
    pre_budget_rank: 1 as number | null,
    selection_order: 1,
    fused_rank: 1 as number | null,
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

  const buildDelivered = (rank: number) => ({
    object_id: `d-${rank}`,
    object_kind: "memory_entry",
    dimension: null,
    rank,
    relevance_score: 0.5,
    fused_rank: rank,
    fused_score: 0.5,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: { lexical_fts: 0.5 },
    plane_first_admitted: null,
    plane_winning_admission: null,
    score_factors: null
  });

  const buildQuestion = (
    gold: ReadonlyArray<ReturnType<typeof buildGold>>,
    delivered: ReadonlyArray<ReturnType<typeof buildDelivered>>,
    hitAt5: boolean
  ) =>
    ({
      question_id: "q-per-gold",
      round_index: null,
      gold_memory_ids: gold.map((g) => g.object_id),
      answer_session_ids: ["session-a"],
      delivered_results: delivered,
      active_constraint_results: [],
      hit_at_1: hitAt5,
      hit_at_5: hitAt5,
      hit_at_10: hitAt5,
      miss_classification: hitAt5 ? ("hit_at_5" as const) : ("under_ranked" as const),
      degradation_reason: null,
      recall_diagnostics_present: true,
      recall_diagnostics_keys: [],
      provider_state: "provider_not_requested" as const,
      provider_degradation_reason: null,
      graph_expansion_plane_count_per_hop: [0, 0] as const,
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0,
        recalls: 0,
        supports: 0
      },
      candidate_key_collisions: [],
      gold
    }) as unknown as LongMemEvalQuestionDiagnostic;

  it("splits gold ranks {3,8,60} by ordinal and attributes displaced slots", () => {
    const golds = [
      buildGold({ object_id: "g-a", final_rank: 3, pre_budget_rank: 3 }),
      buildGold({
        object_id: "g-b",
        candidate_status: "candidate_not_delivered",
        final_rank: null,
        pre_budget_rank: 8
      }),
      buildGold({
        object_id: "g-c",
        candidate_status: "candidate_not_delivered",
        final_rank: null,
        pre_budget_rank: 60
      })
    ];
    const metrics = buildLongMemEvalQualityMetrics([
      buildQuestion(golds, [buildDelivered(1), buildDelivered(2)], true)
    ]);

    const buckets = metrics.per_gold_rank_buckets;
    if (!buckets) throw new Error("per_gold_rank_buckets missing");
    // ordinal 0 = best gold (g-a delivered at rank 3).
    expect(buckets.gold_ordinal_0.delivered_top5).toBe(1);
    // ordinal 1plus = g-b @8 -> 6_10, g-c @60 -> 51_100.
    expect(buckets.gold_ordinal_1plus.pre_budget_6_10).toBe(1);
    expect(buckets.gold_ordinal_1plus.pre_budget_51_100).toBe(1);
    expect(buckets.gold_ordinal_0.pre_budget_6_10).toBe(0);
    // 2 missed ordinal_1plus golds x 2 top-5 delivered (lexical) = 4.
    expect(metrics.per_gold_displaced_by?.lexical_topic_neighbor).toBe(4);
  });

  it("keeps best gold out of ordinal_1plus when all golds hit top-5", () => {
    const golds = [
      buildGold({ object_id: "g-a", final_rank: 1, pre_budget_rank: 1 }),
      buildGold({ object_id: "g-b", final_rank: 4, pre_budget_rank: 4 })
    ];
    const metrics = buildLongMemEvalQualityMetrics([
      buildQuestion(golds, [buildDelivered(1), buildDelivered(4)], true)
    ]);
    const buckets = metrics.per_gold_rank_buckets;
    if (!buckets) throw new Error("per_gold_rank_buckets missing");
    expect(buckets.gold_ordinal_0.delivered_top5).toBe(1);
    expect(buckets.gold_ordinal_1plus.delivered_top5).toBe(1);
    // no missed ordinal_1plus gold -> no displacement attribution.
    expect(metrics.per_gold_displaced_by?.lexical_topic_neighbor).toBe(0);
  });
});
