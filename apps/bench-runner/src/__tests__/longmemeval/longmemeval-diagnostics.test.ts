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

describe("LongMemEval recall diagnostics", () => {

  it("accepts graph expansion per-hop and per-edge-type counts in the strict bench schema", () => {
    const parsed = BenchRecallDiagnosticsSchema.parse({
      query_probes: emptyQueryProbes,
      total_scanned: 0,
      candidate_pool_count: 0,
      pre_budget_count: 0,
      delivered_count: 0,
      embedding_provider_status: "provider_not_requested",
      provider_degradation_reason: null,
      degradation_reasons: ["evidence_fts_failed", "path_expansion_failed"],
      embedding_workspace_scan_cap: 10000,
      embedding_workspace_scanned_count: 10001,
      embedding_workspace_truncated: true,
      embedding_workspace_provider_kind: "openai",
      embedding_workspace_model_id: "text-embedding-3-small",
      embedding_workspace_schema_version: 1,
      graph_expansion_plane_count_per_hop: [1, 2],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 1,
        recalls: 1,
        supports: 1
      },
      phase_latency_ms: {
        coarse_filter: 1.25,
        fusion: 2.5
      },
      fusion_breakdown: [],
      candidates: [],
      token_economy: {
        delivered_context_tokens_estimate: 0,
        coarse_pool_size: 0,
        fine_evaluated: 0,
        fusion_streams_with_hits: 0,
        embedding_inference_calls: 0
      }
    });

    expect(parsed.graph_expansion_plane_count_per_hop).toEqual([1, 2]);
    expect(parsed.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 1,
      recalls: 1,
      supports: 1
    });
    expect(parsed.phase_latency_ms).toEqual({
      coarse_filter: 1.25,
      fusion: 2.5
    });
    expect(parsed.degradation_reasons).toEqual(["evidence_fts_failed", "path_expansion_failed"]);
    expect(parsed.embedding_workspace_truncated).toBe(true);
    expect(parsed.embedding_workspace_scanned_count).toBe(10001);
  });

  it("round-trips per-candidate coverage/session actions through gold diagnostics", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-coverage-action",
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
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-a",
              pre_budget_rank: 7,
              selection_order: 7,
              fused_rank: 7,
              fused_score: 0.4,
              final_rank: null,
              dropped_reason: "max_entries",
              coverage_selector_action: "promoted",
              session_coverage_action: "displaced",
              session_key: "session-a",
              source_cohort_key: "source-a"
            }
          ]
        }
      }
    });

    expect(row.gold[0]).toMatchObject({
      coverage_selector_action: "promoted",
      session_coverage_action: "displaced",
      session_key: "session-a",
      source_cohort_key: "source-a"
    });
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(row);
    expect(parsed.gold[0]?.coverage_selector_action).toBe("promoted");
    expect(() =>
      LongMemEvalGoldDiagnosticSchema.parse({
        ...parsed.gold[0],
        coverage_selector_action: "applied"
      })
    ).toThrow();
  });

  it("persists phase latency into per-question diagnostics", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-phase-latency",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "gold-a",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          provider_state: "provider_not_requested",
          graph_expansion_plane_count_per_hop: [0, 0],
          graph_expansion_plane_count_per_edge_type: {
            derives_from: 0,
            recalls: 0,
            supports: 0
          },
          phase_latency_ms: {
            coarse_filter: 1.25,
            fusion: 2.5
          },
          candidates: []
        }
      }
    });

    expect(row.phase_latency_ms).toEqual({
      coarse_filter: 1.25,
      fusion: 2.5
    });
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row).phase_latency_ms).toEqual({
      coarse_filter: 1.25,
      fusion: 2.5
    });
  });

  it("carries graph expansion diagnostics into scored recall evidence summaries", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-graph",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "gold-a",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          provider_state: "provider_not_requested",
          graph_expansion_plane_count_per_hop: [1, 2],
          graph_expansion_plane_count_per_edge_type: {
            derives_from: 1,
            recalls: 1,
            supports: 1
          },
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-a",
              admission_planes: ["graph_expansion"],
              plane_first_admitted: "graph_expansion",
              plane_winning_admission: "graph_expansion",
              pre_budget_rank: 1,
              selection_order: 1,
              fused_rank: 1,
              fused_score: 0.9,
              per_stream_rank: { graph_expansion: 1 },
              fused_rank_contribution_per_stream: { graph_expansion: 0.04 },
              final_rank: 1,
              dropped_reason: null,
              within_budget: true,
              relevance_score: 0.9,
              lexical_rank: null,
              structural_score: 1,
              score_factors: {},
              source_channels: ["graph_expansion"],
              path_expansion_sources: []
            }
          ]
        }
      }
    });

    expect(row.graph_expansion_plane_count_per_hop).toEqual([1, 2]);
    expect(row.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 1,
      recalls: 1,
      supports: 1
    });

    const summary = summarizeLongMemEvalRecallEvidence([row]);
    expect(summary.graph_expansion_plane_count_per_hop).toEqual([1, 2]);
    expect(summary.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 1,
      recalls: 1,
      supports: 1
    });
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
});
