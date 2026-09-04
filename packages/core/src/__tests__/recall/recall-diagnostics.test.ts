import { describe, expect, it } from "vitest";

import { buildRecallDiagnostics } from "../../recall/runtime/diagnostics.js";
import { compileRecallAnswerShapePlan } from "../../recall/query/recall-answer-shape-plan.js";
import type {
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics,
  RecallCandidateDiagnostic
} from "../../recall/runtime/recall-service-types.js";
import {
  captureRecallQueryEntities
} from "../../recall/field/query-entity-attribution-producer.js";
import {
  materializeRecallRetrievalFieldCaptures,
  RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1
} from "../../recall/field/finite-field-capture.js";

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
  lexical_terms: ["alice", "live"],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
});

describe("recall diagnostics", () => {
  it("preserves optional conformant axis and flood diagnostics in fusion breakdown", async () => {
    const floodPotential: IntegratedFloodCandidateDiagnostics = Object.freeze({
      R_obj: 0.2,
      Slice: 1,
      A_path: 0.4,
      B_evidence: 0.5,
      E_direct: 0.6,
      omega: 1,
      Flood: 0.2,
      lambda: 0.15,
      beta: 1,
      final_score: 0.23,
      slice_status: "active",
      path_status: "active",
      evidence_status: "active",
      e_direct_status: "active",
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
      flood_fuel_coverage: floodFuelCoverage,
      admission_attempts: Object.freeze([]),
      evidence_projection_matches: Object.freeze([])
    });

    const params = {
      queryProbes: emptyQueryProbes,
      queryEntityExtraction: await captureRecallQueryEntities({ query_text: null }),
      retrievalFieldCaptures: materializeRecallRetrievalFieldCaptures([]),
      answerShapePlan: compileRecallAnswerShapePlan(emptyQueryProbes),
      querySoughtFacets: ["location_place"],
      totalScanned: 1,
      candidatePoolCount: 1,
      preBudgetCount: 1,
      deliveredCount: 1,
      embeddingProviderStatus: "provider_not_requested",
      embeddingSupplementStatus: "disabled",
      evidenceEmbeddingScoring: {
        activationsByCandidateKey: new Map(),
        status: "not_applicable",
        expectedCount: 0,
        scoredCount: 0,
        inferenceCalls: 0,
        latencyMs: 0,
        failureClass: null,
        selectionReceipt: {
          schema_version: 1,
          operator_id: "ordered_candidate_prefix_v1",
          input_candidate_keys: ["workspace_local:memory_entry:memory-a"],
          owner_gist_enabled: true,
          owner_gist_candidate_keys: ["workspace_local:memory_entry:memory-a"],
          full_evidence_candidate_keys: ["workspace_local:memory_entry:memory-a"],
          owner_gist_limit: 16,
          full_evidence_limit: 32,
          input_memory_count: 1,
          owner_gist_selected_count: 1,
          full_evidence_selected_count: 1,
          owner_gist_excluded_count: 0,
          full_evidence_excluded_count: 0
        }
      },
      providerDegradationReason: null,
      answerRerankDiagnostics: {
        status: "not_requested",
        expected_count: 0,
        scored_count: 0,
        failure_class: null
      },
      graphExpansionDiagnostics: {
        graph_expansion_plane_count_per_hop: [0, 0],
        graph_expansion_plane_count_per_edge_type: {
          derives_from: 0,
          recalls: 0,
          supports: 0
        }
      },
      candidates: [candidate],
      fineAssessmentPrunedCandidates: [],
      tokenEconomy: {
        delivered_context_tokens_estimate: 0,
        coarse_pool_size: 1,
        fine_evaluated: 1,
        fine_pruned_count: 0,
        fine_priority_overflow_count: 0,
        fusion_families_with_hits: 1,
        embedding_inference_calls: 0
      }
    };
    const diagnostics = buildRecallDiagnostics(
      params as unknown as Parameters<typeof buildRecallDiagnostics>[0]
    );

    expect(diagnostics.fusion_breakdown[0]).toMatchObject({
      per_axis_rank: { object: 1, path: 2, evidence: null, temporal: null, control: null },
      per_axis_contribution: { object: 0.2, path: 0.03, evidence: 0, temporal: 0, control: 0 },
      flood_potential: { Flood: 0.2, fuel_verified: true },
      flood_fuel_coverage: { fuel_verified_count: 1 }
    });
    expect(diagnostics.fine_assessment_pruned_candidates).toEqual([]);
    expect(diagnostics.query_probes.normalized_query).toBe("where did alice live");
    expect(diagnostics.answer_shape_plan).toEqual({
      schema_version: 1,
      status: "high_confidence",
      shape: "place",
      target_terms: ["alice"],
      relation_terms: ["live"]
    });
    expect(diagnostics.query_sought_facets).toEqual(["location_place"]);
    expect(diagnostics.query_entity_extraction?.status).toBe("ineligible");
    expect(diagnostics.retrieval_field_captures).toHaveLength(
      RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1.length
    );
    expect(diagnostics.evidence_embedding_selection_receipt).toMatchObject({
      operator_id: "ordered_candidate_prefix_v1",
      input_memory_count: 1,
      owner_gist_selected_count: 1,
      full_evidence_selected_count: 1
    });

    const omitted = buildRecallDiagnostics({
      ...params,
      includeCandidateEvidence: false
    } as unknown as Parameters<typeof buildRecallDiagnostics>[0]);
    expect(omitted.candidates).toEqual([]);
    expect(omitted.fusion_breakdown).toEqual([]);
    expect(omitted.fine_assessment_pruned_candidates).toEqual([]);
    expect(omitted.embedding_provider_status).toBe(diagnostics.embedding_provider_status);
    expect(omitted.pre_budget_count).toBe(1);
    expect(omitted.token_economy).toEqual(diagnostics.token_economy);
  });
});
