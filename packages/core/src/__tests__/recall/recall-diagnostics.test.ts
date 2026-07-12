import { describe, expect, it } from "vitest";

import { buildRecallDiagnostics } from "../../recall/runtime/diagnostics.js";
import type {
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics,
  RecallCandidateDiagnostic
} from "../../recall/runtime/recall-service-types.js";

const emptyQueryProbes = Object.freeze({
  normalized_query: "where did alice live",
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
});

describe("recall diagnostics", () => {
  it("preserves optional conformant axis and flood diagnostics in fusion breakdown", () => {
    const floodPotential: IntegratedFloodCandidateDiagnostics = Object.freeze({
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
    });
    const floodFuelCoverage: FloodFuelCoverageSummary = Object.freeze({
      candidates_total: 1,
      cold_start_count: 0,
      fuel_verified_count: 1,
      slice_active_count: 1,
      path_active_count: 1,
      evidence_active_count: 1
    });
    const candidate: RecallCandidateDiagnostic = Object.freeze({
      candidate_key: "workspace_local:memory_entry:memory-a",
      object_id: "memory-a",
      object_kind: "memory_entry",
      dimension: "fact",
      origin_plane: "workspace_local",
      created_at: "2026-07-07T00:00:00.000Z",
      facet_overlap: 0,
      admission_planes: ["activation"] as RecallCandidateDiagnostic["admission_planes"],
      plane_first_admitted: "activation" as RecallCandidateDiagnostic["plane_first_admitted"],
      plane_winning_admission: "activation" as RecallCandidateDiagnostic["plane_winning_admission"],
      pre_budget_rank: 1,
      selection_order: 1,
      fused_rank: 1,
      fused_score: 0.23,
      per_stream_rank: { lexical_fts: 1 } as RecallCandidateDiagnostic["per_stream_rank"],
      fused_rank_contribution_per_stream: {
        lexical_fts: 0.1
      } as RecallCandidateDiagnostic["fused_rank_contribution_per_stream"],
      final_rank: 1,
      dropped_reason: null,
      within_budget: true,
      relevance_score: 0.8,
      additive_score: 0.8,
      lexical_rank: 1,
      structural_score: 0.1,
      score_factors: { activation: 0.5, relevance: 0.8 },
      source_channels: [],
      path_expansion_sources: [],
      answer_features: {
        content: "Alice lived in Paris.",
        evidence_gist: null,
        evidence_gist_truncated: false,
        domain_tags: [],
        evidence_refs: [],
        facet_tags: [],
        canonical_entities: [],
        projection_schema_version: null,
        event_time_start: null,
        event_time_end: null,
        valid_from: null,
        valid_to: null,
        time_precision: null,
        time_source: null,
        preference_subject: null,
        preference_predicate: null,
        preference_object: null,
        preference_category: null,
        preference_polarity: null
      },
      path_suppression_score: 0,
      per_axis_rank: { object: 1, path: 2, evidence: null, temporal: null, control: null },
      per_axis_contribution: { object: 0.2, path: 0.03, evidence: 0, temporal: 0, control: 0 },
      flood_potential: floodPotential,
      flood_fuel_coverage: floodFuelCoverage
    });

    const diagnostics = buildRecallDiagnostics({
      queryProbes: emptyQueryProbes,
      querySoughtFacets: ["location_place"],
      totalScanned: 1,
      candidatePoolCount: 1,
      preBudgetCount: 1,
      deliveredCount: 1,
      embeddingProviderStatus: "provider_not_requested",
      providerDegradationReason: null,
      graphExpansionDiagnostics: {
        graph_expansion_plane_count_per_hop: [0, 0],
        graph_expansion_plane_count_per_edge_type: {
          derives_from: 0,
          recalls: 0,
          supports: 0
        }
      },
      candidates: [candidate],
      tokenEconomy: {
        delivered_context_tokens_estimate: 0,
        coarse_pool_size: 1,
        fine_evaluated: 1,
        fusion_streams_with_hits: 1,
        embedding_inference_calls: 0
      }
    });

    expect(diagnostics.fusion_breakdown[0]).toMatchObject({
      per_axis_rank: { object: 1, path: 2, evidence: null, temporal: null, control: null },
      per_axis_contribution: { object: 0.2, path: 0.03, evidence: 0, temporal: 0, control: 0 },
      flood_potential: { Flood: 0.2, fuel_verified: true },
      flood_fuel_coverage: { fuel_verified_count: 1 }
    });
    expect(diagnostics.query_probes.normalized_query).toBe("where did alice live");
    expect(diagnostics.query_sought_facets).toEqual(["location_place"]);
  });
});
