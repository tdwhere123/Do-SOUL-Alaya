import { describe, expect, it } from "vitest";

import { BenchRecallDiagnosticsSchema } from "../../harness/recall-diagnostics-schema.js";

import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalMissTaxonomySchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../longmemeval/diagnostics-schema.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  includeReplayCandidatePoolInDiagnosticsWrite,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  stripReplayCandidatePoolsForGateWrite,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
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

describe("LongMemEval recall diagnostics (legacy/order/pool)", () => {

  it("classifies question misses into the durable diagnostics taxonomy", () => {
    expect(LongMemEvalMissTaxonomySchema.options).toEqual([
      "candidate_absent",
      "materialization_drop",
      "budget_drop",
      "delivery_order_drop",
      "answer_set_coverage_drop",
      "evaluation_or_gold_issue"
    ]);
    const materializationDrop = buildQuestionDiagnostic({
      questionId: "q-materialization-drop",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "synthesis_capsule",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:synthesis_capsule:gold-a"
            }
          ]
        }
      }
    });
    const budgetDrop = buildQuestionDiagnostic({
      questionId: "q-budget-drop",
      goldMemoryIds: ["gold-b"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-b",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-b",
              pre_budget_rank: 4,
              final_rank: null,
              dropped_reason: "max_entries"
            }
          ]
        }
      }
    });
    const deliveryOrderDrop = buildQuestionDiagnostic({
      questionId: "q-delivery-order-drop",
      goldMemoryIds: ["gold-c"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-c", rank: 8, relevance_score: 0.3 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-c",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-c",
              final_rank: 8,
              fused_rank: 4
            }
          ]
        }
      }
    });
    const candidateAbsent = buildQuestionDiagnostic({
      questionId: "q-candidate-absent",
      goldMemoryIds: ["gold-d"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGold = buildQuestionDiagnostic({
      questionId: "q-no-gold",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGoldMaterializationDrop = buildQuestionDiagnostic({
      questionId: "q-no-gold-materialization-drop",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      seedDropReasons: {
        candidate_absent: 0,
        materialization_drop: 1
      },
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGoldCandidateAbsent = buildQuestionDiagnostic({
      questionId: "q-no-gold-candidate-absent",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      seedDropReasons: {
        candidate_absent: 2,
        materialization_drop: 0
      },
      recallResult: { diagnostics: { candidates: [] } }
    });

    expect(materializationDrop.miss_taxonomy).toBe("materialization_drop");
    expect(materializationDrop.gold[0]?.miss_taxonomy).toBe("materialization_drop");
    expect(budgetDrop.miss_taxonomy).toBe("budget_drop");
    expect(deliveryOrderDrop.miss_taxonomy).toBe("delivery_order_drop");
    expect(candidateAbsent.miss_taxonomy).toBe("candidate_absent");
    expect(noGold.miss_taxonomy).toBe("evaluation_or_gold_issue");
    expect(noGoldMaterializationDrop.miss_taxonomy).toBe("materialization_drop");
    expect(noGoldCandidateAbsent.miss_taxonomy).toBe("candidate_absent");

    const answerSetCoverageDrop = buildQuestionDiagnostic({
      questionId: "q-answer-set-coverage-drop",
      goldMemoryIds: ["gold-e"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-e", rank: 8, relevance_score: 0.3 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-e",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-e",
              final_rank: 8,
              fused_rank: 3,
              rank_after_fusion: 3,
              rank_after_coverage_selector: 8,
              coverage_selector_action: "displaced"
            }
          ]
        }
      }
    });
    expect(answerSetCoverageDrop.miss_taxonomy).toBe("answer_set_coverage_drop");
    expect(answerSetCoverageDrop.gold[0]?.miss_taxonomy).toBe(
      "answer_set_coverage_drop"
    );

    const summary = summarizeLongMemEvalRecallEvidence([
      materializationDrop,
      budgetDrop,
      deliveryOrderDrop,
      candidateAbsent,
      noGold,
      noGoldMaterializationDrop,
      noGoldCandidateAbsent
    ]);
    expect(summary.miss_taxonomy_distribution).toEqual({
      candidate_absent: 2,
      materialization_drop: 2,
      budget_drop: 1,
      delivery_order_drop: 1,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 1
    });
    expect(
      buildLongMemEvalQualityMetrics([
        materializationDrop,
        budgetDrop,
        deliveryOrderDrop,
        candidateAbsent,
        noGold,
        noGoldMaterializationDrop,
        noGoldCandidateAbsent
      ]).miss_taxonomy_distribution
    ).toEqual(summary.miss_taxonomy_distribution);
  });


  it("defaults omitted legacy graph expansion counters without weakening the strict sidecar schema", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-legacy",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          provider_state: "provider_not_requested",
          graph_expansion_plane_count_per_hop: [1, 1],
          graph_expansion_plane_count_per_edge_type: {
            derives_from: 1,
            recalls: 0,
            supports: 1
          },
          candidates: []
        }
      }
    });
    const {
      graph_expansion_plane_count_per_hop: _hopCounts,
      graph_expansion_plane_count_per_edge_type: _edgeTypeCounts,
      ...legacyRow
    } = row;

    const summary = summarizeLongMemEvalRecallEvidence([
      legacyRow as unknown as typeof row
    ]);

    expect(summary.graph_expansion_plane_count_per_hop).toEqual([0, 0]);
    expect(summary.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 0
    });
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse(legacyRow)).toThrow();
    expect(() =>
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...row,
        graph_expansion_plane_count_per_hop: ["bad", 0]
      })
    ).toThrow();
  });

  it("defaults omitted legacy miss taxonomy fields while keeping invalid values strict", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-legacy-taxonomy",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    const legacyRow = {
      ...row,
      gold: row.gold.map(({ miss_taxonomy: _missTaxonomy, ...gold }) => gold)
    };
    const { miss_taxonomy: _rowMissTaxonomy, ...legacyQuestion } = legacyRow;

    expect(LongMemEvalQuestionDiagnosticSchema.parse(legacyQuestion).miss_taxonomy).toBeNull();
    expect(
      LongMemEvalQuestionDiagnosticSchema.parse(legacyQuestion).gold[0]?.miss_taxonomy
    ).toBeNull();
    expect(() =>
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...row,
        miss_taxonomy: "under_ranked"
      })
    ).toThrow();
  });

  it("does not flag valid final delivery order when fused ranks decrease after rerank", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-final-rerank",
      goldMemoryIds: ["memory-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        { object_id: "memory-a", rank: 1, relevance_score: 0.8 },
        { object_id: "memory-b", rank: 2, relevance_score: 0.95 },
        { object_id: "memory-c", rank: 3, relevance_score: 0.7 }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            { object_id: "memory-a", final_rank: 1, fused_rank: 2 },
            { object_id: "memory-b", final_rank: 2, fused_rank: 1 },
            { object_id: "memory-c", final_rank: 3, fused_rank: 3 }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);

    expect(row.delivered_results.map((result) => result.rank)).toEqual([1, 2, 3]);
    expect(row.delivered_results.map((result) => result.fused_rank)).toEqual([
      2,
      1,
      3
    ]);
    expect(metrics.non_monotonic_count).toBe(0);
    expect(metrics.non_monotonic_rate).toBe(0);
  });

  it("flags delivered rows that are not ordered by final delivered rank", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-final-rank-disorder",
      goldMemoryIds: ["memory-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        { object_id: "memory-a", rank: 1, relevance_score: 0.9 },
        { object_id: "memory-b", rank: 3, relevance_score: 0.8 },
        { object_id: "memory-c", rank: 2, relevance_score: 0.7 }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            { object_id: "memory-a", final_rank: 1, fused_rank: 1 },
            { object_id: "memory-b", final_rank: 3, fused_rank: 2 },
            { object_id: "memory-c", final_rank: 2, fused_rank: 3 }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);

    expect(metrics.non_monotonic_count).toBe(1);
    expect(metrics.non_monotonic_rate).toBe(1);
  });

  it("falls back to fused rank order for legacy rows without delivered ranks", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-legacy-fused-rank",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });
    const legacyRow = {
      ...row,
      delivered_results: [
        {
          object_id: "memory-b",
          relevance_score: 0.4,
          fused_rank: 2,
          fused_score: null,
          per_stream_rank: null,
          fused_rank_contribution_per_stream: null,
          plane_first_admitted: null,
          plane_winning_admission: null,
          score_factors: null
        },
        {
          object_id: "memory-a",
          relevance_score: 0.5,
          fused_rank: 1,
          fused_score: null,
          per_stream_rank: null,
          fused_rank_contribution_per_stream: null,
          plane_first_admitted: null,
          plane_winning_admission: null,
          score_factors: null
        }
      ]
    } as unknown as typeof row;

    const metrics = buildLongMemEvalQualityMetrics([legacyRow]);

    expect(metrics.non_monotonic_count).toBe(1);
    expect(metrics.non_monotonic_rate).toBe(1);
  });

  it("strips replay candidate pools for default gate writes", () => {
    const previous = process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL;
    delete process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL;
    try {
      expect(includeReplayCandidatePoolInDiagnosticsWrite()).toBe(false);
      const question = buildQuestionDiagnostic({
        questionId: "q-pool",
        goldMemoryIds: ["gold-a"],
        answerSessionIds: ["session-a"],
        deliveredResults: [
          { object_id: "gold-a", rank: 1, relevance_score: 0.9 }
        ],
        hitAt1: true,
        hitAt5: true,
        hitAt10: true,
        degradationReason: null,
        embeddingMode: "disabled",
        recallResult: {
          diagnostics: {
            candidates: [
              {
                object_id: "gold-a",
                object_kind: "memory_entry",
                origin_plane: "workspace_local",
                candidate_key: "workspace_local:memory_entry:gold-a",
                created_at: "2026-07-07T00:00:00.000Z",
                facet_overlap: 2,
                pre_budget_rank: 1,
                selection_order: 1,
                fused_rank: 1,
                fused_score: 0.4,
                final_rank: 1,
                per_stream_rank: { lexical_fts: 1 },
                fused_rank_contribution_per_stream: { lexical_fts: 0.3 },
                score_factors: { activation: 0.7 }
              }
            ]
          }
        }
      });
      expect(question.candidates.length).toBeGreaterThan(0);
      const stripped = stripReplayCandidatePoolsForGateWrite({
        schema_version: 1,
        bench_name: "public",
        split: "longmemeval_s",
        run_at: "2026-07-09T00:00:00.000Z",
        alaya_commit: "deadbeef",
        embedding_provider: "local_onnx",
        embedding_mode: "env",
        provider_state_summary: {
          total: 1,
          provider_returned: 0,
          provider_pending: 0,
          provider_failed: 0,
          provider_not_requested: 1,
          unknown: 0,
          provider_returned_rate: 0,
          provider_pending_rate: 0,
          provider_failed_rate: 0,
          provider_not_requested_rate: 1,
          unknown_rate: 0
        },
        questions: [question]
      });
      expect(stripped.questions[0]?.candidates).toEqual([]);
      expect(stripped.questions[0]?.candidate_pool_complete).toBe(false);
      const rendered = renderDiagnosticsSidecar(stripped);
      expect(rendered).not.toContain("workspace_local:memory_entry:gold-a");
      expect(rendered.length).toBeLessThan(8_000);
    } finally {
      if (previous === undefined) {
        delete process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL;
      } else {
        process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL = previous;
      }
    }
  });

  it("keeps replay candidate pools when ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL=1", () => {
    const previous = process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL;
    process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL = "1";
    try {
      expect(includeReplayCandidatePoolInDiagnosticsWrite()).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL;
      } else {
        process.env.ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL = previous;
      }
    }
  });

});
