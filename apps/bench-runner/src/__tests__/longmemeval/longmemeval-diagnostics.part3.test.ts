import { describe, expect, it } from "vitest";

import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  buildQuestionDiagnostic,
  summarizeLongMemEvalRecallEvidence
} from "../../longmemeval/diagnostics.js";

describe("LongMemEval recall diagnostics (fusion/graph)", () => {
  it("joins fusion breakdown details into delivered and gold diagnostics", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-fusion-breakdown",
      questionType: "temporal-reasoning",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      isAbstention: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          fusion_breakdown: [
            {
              candidate_key: "workspace_local:memory_entry:gold-a",
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              per_axis_rank: { object: 1, path: 2, evidence: null },
              per_axis_contribution: { object: 0.2, path: 0.03, evidence: 0 },
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
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-a",
              final_rank: 1,
              fused_rank: 1
            }
          ]
        }
      }
    });

    expect(row.question_type).toBe("temporal-reasoning");
    expect(row.is_abstention).toBe(false);
    expect(row.premise_invalid).toBe(false);
    expect(row.delivered_results[0]).toMatchObject({
      per_axis_rank: { object: 1, path: 2, evidence: null },
      flood_potential: { Flood: 0.2, fuel_verified: true },
      flood_fuel_coverage: { fuel_verified_count: 1 }
    });
    expect(
      row.delivered_results[0]?.abstention_confidence_score === null ||
        typeof row.delivered_results[0]?.abstention_confidence_score === "number"
    ).toBe(true);
    expect(row.gold[0]).toMatchObject({
      per_axis_contribution: { object: 0.2, path: 0.03, evidence: 0 },
      flood_potential: { Flood: 0.2, fuel_verified: true },
      flood_fuel_coverage: { fuel_verified_count: 1 }
    });
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row).question_type).toBe(
      "temporal-reasoning"
    );
  });

  it("does not invent per-axis or flood diagnostics when fusion identity does not match", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-unmatched-fusion-breakdown",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          fusion_breakdown: [
            {
              candidate_key: "workspace_local:memory_entry:gold-a",
              object_id: "other-gold",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              per_axis_rank: { object: 1 },
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
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-a",
              final_rank: 1,
              fused_rank: 1
            }
          ]
        }
      }
    });

    expect(row.delivered_results[0]?.per_axis_rank).toBeNull();
    expect(row.gold[0]?.flood_fuel_coverage).toBeNull();
  });

  it("does not normalize malformed flood fuel coverage counters", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-malformed-flood-coverage",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          fusion_breakdown: [
            {
              candidate_key: "workspace_local:memory_entry:gold-a",
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              flood_fuel_coverage: {
                candidates_total: 1.5,
                cold_start_count: 0,
                fuel_verified_count: 1,
                slice_active_count: 1,
                path_active_count: 1,
                evidence_active_count: 1
              }
            }
          ],
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-a",
              final_rank: 1,
              fused_rank: 1
            }
          ]
        }
      }
    });

    expect(row.delivered_results[0]?.flood_fuel_coverage).toBeNull();
    expect(row.gold[0]?.flood_fuel_coverage).toBeNull();
  });

  it("carries graph expansion diagnostics into scored recall evidence summaries", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-graph",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 0.9 }],
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
});
