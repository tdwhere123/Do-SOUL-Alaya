import { describe, expect, it } from "vitest";

import { BenchRecallDiagnosticsSchema } from "../../../harness/recall/recall-diagnostics-schema.js";

import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalMissTaxonomySchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  stripReplayCandidatePoolsForGateWrite,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "../../../longmemeval/diagnostics.js";

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
      embedding_supplement_status: "not_attempted",
      provider_degradation_reason: null,
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null,
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
      fine_assessment_pruned_candidates: [],
      token_economy: {
        delivered_context_tokens_estimate: 0,
        coarse_pool_size: 0,
        fine_evaluated: 0,
        fine_pruned_count: 0,
        fusion_families_with_hits: 0,
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
    expect(parsed.embedding_supplement_status).toBe("not_attempted");
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

  it("persists complete replay candidate rows when raw recall diagnostics carry replay inputs", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-replay-candidates",
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
          candidate_pool_count: 1,
          fine_assessment_pruned_candidates: [],
          token_economy: {
            coarse_pool_size: 1,
            fine_evaluated: 1,
            fine_pruned_count: 0
          },
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
              answer_relevance_score: 0.93,
              answer_relevance_rank: 2,
              final_rank: 1,
              per_stream_rank: {
                lexical_fts: 1,
                facet_overlap: 1
              },
              fused_rank_contribution_per_stream: {
                lexical_fts: 0.3,
                facet_overlap: 0.2
              },
              score_factors: {
                activation: 0.7,
                relevance: 0.9
              }
            }
          ]
        }
      }
    });

    expect(row.candidate_pool_complete).toBe(true);
    expect(row.candidates[0]).toMatchObject({
      object_id: "gold-a",
      candidate_key: "workspace_local:memory_entry:gold-a",
      answer_relevance_score: 0.93,
      answer_relevance_rank: 2,
      score_factors: {
        activation: 0.7,
        facet_overlap: 2,
        created_at: "2026-07-07T00:00:00.000Z"
      }
    });
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(row);
    expect(parsed.candidates[0]).toMatchObject({
      answer_relevance_score: 0.93,
      answer_relevance_rank: 2,
      score_factors: {
        facet_overlap: 2,
        created_at: "2026-07-07T00:00:00.000Z"
      }
    });
    expect(parsed.gold[0]).toMatchObject({
      answer_relevance_score: 0.93,
      answer_relevance_rank: 2
    });
    expect(row.gold[0]).toMatchObject({
      answer_relevance_score: 0.93,
      answer_relevance_rank: 2
    });
  });

  it("does not declare replay candidate pools complete when tie-break inputs are missing", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-incomplete-replay-candidates",
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
              pre_budget_rank: 1,
              selection_order: 1,
              fused_rank: 1,
              fused_score: 0.4,
              final_rank: null,
              per_stream_rank: { lexical_fts: 1 },
              fused_rank_contribution_per_stream: { lexical_fts: 0.3 },
              score_factors: {
                activation: 0.7,
                relevance: 0.9
              }
            }
          ]
        }
      }
    });

    expect(row.candidate_pool_complete).toBe(false);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row).candidate_pool_complete).toBe(false);
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

  it("accepts conformant axis and flood diagnostics in the strict bench schema", () => {
    const parsed = BenchRecallDiagnosticsSchema.parse({
      query_probes: emptyQueryProbes,
      total_scanned: 1,
      candidate_pool_count: 1,
      pre_budget_count: 1,
      delivered_count: 1,
      embedding_provider_status: "provider_not_requested",
      provider_degradation_reason: null,
      answer_rerank_status: "not_requested",
      answer_rerank_expected_count: 0,
      answer_rerank_scored_count: 0,
      answer_rerank_failure_class: null,
      graph_expansion_plane_count_per_hop: [0, 0],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0,
        recalls: 0,
        supports: 0
      },
      fusion_breakdown: [
        {
          candidate_key: "workspace_local:memory_entry:gold-a",
          object_id: "gold-a",
          object_kind: "memory_entry",
          origin_plane: "workspace_local",
          facet_overlap: 2,
          per_stream_rank: {
            lexical_fts: 1,
            trigram_fts: null,
            synthesis_fts: null,
            evidence_fts: null,
            evidence_structural_agreement: null,
            source_proximity: null,
            source_evidence_agreement: null,
            subject_alignment: null,
            structural: null,
            existing_score: null,
            embedding_similarity: null,
            graph_expansion: null,
            entity_seed: null,
            path_expansion: null,
            temporal_recency: null,
            workspace_activation: null,
            facet_overlap: null
          },
          fused_rank: 1,
          fused_score: 0.23,
          fused_rank_contribution_per_stream: {
            lexical_fts: 0.1,
            trigram_fts: 0,
            synthesis_fts: 0,
            evidence_fts: 0,
            evidence_structural_agreement: 0,
            source_proximity: 0,
            source_evidence_agreement: 0,
            subject_alignment: 0,
            structural: 0,
            existing_score: 0,
            embedding_similarity: 0,
            graph_expansion: 0,
            entity_seed: 0,
            path_expansion: 0,
            temporal_recency: 0,
            workspace_activation: 0,
            facet_overlap: 0
          },
          per_axis_rank: {
            object: 1,
            path: 2,
            evidence: null,
            temporal: null,
            control: null
          },
          per_axis_contribution: {
            object: 0.2,
            path: 0.03,
            evidence: 0,
            temporal: 0,
            control: 0
          },
          flood_potential: {
            R_obj: 0.2,
            Slice: 1,
            A_path: 0.4,
            B_evidence: 0.5,
            E_direct: 0.6,
            omega: 1,
            Flood: 0.2,
            lambda: 0.15,
            beta: 0,
            final_score: 0.23,
            slice_status: "active",
            path_status: "active",
            evidence_status: "active",
            e_direct_status: "inactive:beta_disabled",
            fuel_verified: true
          },
          flood_fuel_coverage: {
            candidates_total: 1,
            cold_start_count: 0,
            fuel_verified_count: 1,
            slice_active_count: 1,
            path_active_count: 1,
            evidence_active_count: 1
          }
        }
      ],
      candidates: [],
      fine_assessment_pruned_candidates: [],
      token_economy: {
        delivered_context_tokens_estimate: 0,
        coarse_pool_size: 1,
        fine_evaluated: 1,
        fine_pruned_count: 0,
        fusion_families_with_hits: 1,
        embedding_inference_calls: 0
      }
    });

    expect(parsed.fusion_breakdown[0]?.per_axis_rank).toMatchObject({
      object: 1,
      path: 2
    });
    expect(parsed.fusion_breakdown[0]?.flood_potential?.fuel_verified).toBe(true);
    expect(parsed.fusion_breakdown[0]?.flood_fuel_coverage?.fuel_verified_count).toBe(1);
  });

});
