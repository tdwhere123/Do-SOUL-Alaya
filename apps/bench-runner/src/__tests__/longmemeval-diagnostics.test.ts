import { describe, expect, it } from "vitest";
import { BenchRecallDiagnosticsSchema } from "../harness/recall-diagnostics-schema.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../longmemeval/diagnostics-schema.js";
import {
  buildQuestionDiagnostic,
  summarizeLongMemEvalRecallEvidence
} from "../longmemeval/diagnostics.js";

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
      graph_expansion_plane_count_per_hop: [1, 2],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 1,
        recalls: 1,
        supports: 1
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
});
