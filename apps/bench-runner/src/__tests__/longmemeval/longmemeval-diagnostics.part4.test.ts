import { describe, expect, it } from "vitest";

import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  renderDiagnosticsSidecar,
  stripReplayCandidatePoolsForGateWrite,
  summarizeLongMemEvalRecallEvidence
} from "../../longmemeval/diagnostics.js";

describe("LongMemEval recall diagnostics (legacy/order/pool continued)", () => {
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

  it("strips replay candidate pools for an explicit compact projection", () => {
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
  });

});
