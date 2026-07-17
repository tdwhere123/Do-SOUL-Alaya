import { describe, expect, it } from "vitest";
import {
  BenchRecallDiagnosticsSchema,
  parseBenchRecallDiagnosticsForRun
} from "../../../harness/recall/recall-diagnostics-schema.js";
import { buildQuestionDiagnostic } from "../../../longmemeval/diagnostics.js";

const fusionStreams = [
  "lexical_fts",
  "trigram_fts",
  "synthesis_fts",
  "evidence_fts",
  "evidence_structural_agreement",
  "source_proximity",
  "source_evidence_agreement",
  "subject_alignment",
  "structural",
  "existing_score",
  "embedding_similarity",
  "graph_expansion",
  "entity_seed",
  "path_expansion",
  "temporal_recency",
  "workspace_activation",
  "facet_overlap"
] as const;

const baseCandidate = {
  candidate_key: "workspace_local:memory_entry:gold-a",
  object_id: "gold-a",
  object_kind: "memory_entry",
  origin_plane: "workspace_local",
  admission_planes: ["lexical"],
  plane_first_admitted: "lexical",
  plane_winning_admission: "lexical",
  pre_budget_rank: 2,
  selection_order: 2,
  fused_rank: 7,
  fused_score: 0.4,
  per_stream_rank: Object.fromEntries(fusionStreams.map((key) => [key, null])),
  fused_rank_contribution_per_stream: Object.fromEntries(
    fusionStreams.map((key) => [key, 0])
  ),
  final_rank: 2,
  dropped_reason: null,
  within_budget: true,
  relevance_score: 0.93,
  lexical_rank: null,
  structural_score: 0,
  score_factors: {},
  source_channels: ["lexical"],
  path_expansion_sources: []
};

const baseDiagnostics = {
  query_probes: {
    normalized_query: "question",
    object_ids: [], subject_hints: [], evidence_refs: [], run_ids: [], surface_ids: [],
    file_paths: [], command_names: [], package_names: [], task_refs: [], dimensions: [],
    scope_classes: [], domain_tags: [], lexical_terms: [], expanded_terms: [], phrases: [],
    char_ngrams: [], date_terms: []
  },
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
  graph_expansion_plane_count_per_edge_type: { derives_from: 0, recalls: 0, supports: 0 },
  fusion_breakdown: [],
  fine_assessment_pruned_candidates: [],
  token_economy: {
    delivered_context_tokens_estimate: 0,
    coarse_pool_size: 1,
    fine_evaluated: 1,
    fine_pruned_count: 0,
    fusion_families_with_hits: 0,
    embedding_inference_calls: 0
  }
};

describe("answer relevance candidate diagnostics", () => {
  it("accepts bounded score and positive rank in the strict candidate schema", () => {
    const parsed = BenchRecallDiagnosticsSchema.parse({
      ...baseDiagnostics,
      candidates: [{
        ...baseCandidate,
        answer_relevance_score: 0.93,
        answer_relevance_rank: 2
      }]
    });
    expect(parsed.candidates[0]).toMatchObject({
      answer_relevance_score: 0.93,
      answer_relevance_rank: 2
    });
    expect(BenchRecallDiagnosticsSchema.safeParse({
      ...baseDiagnostics,
      candidates: [{
        ...baseCandidate,
        answer_relevance_score: 1.01,
        answer_relevance_rank: 0
      }]
    }).success).toBe(false);
  });

  it("fails the treatment run when a non-empty pool did not return every score", () => {
    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      answer_rerank_status: "failed",
      answer_rerank_expected_count: 1,
      answer_rerank_failure_class: "service_error",
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true" })).toThrow(
      /cross-encoder treatment activation failed/u
    );

    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 1,
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true" })).toThrow(
      /expected 1 scores but received 0/u
    );
  });

  it("accepts complete scoring and only permits empty-pool inapplicability", () => {
    expect(parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 1,
      answer_rerank_scored_count: 1,
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "1" }).answer_rerank_status).toBe(
      "returned"
    );

    expect(parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      total_scanned: 0,
      candidate_pool_count: 0,
      pre_budget_count: 0,
      delivered_count: 0,
      answer_rerank_status: "not_applicable",
      candidates: []
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true" }).answer_rerank_status).toBe(
      "not_applicable"
    );

    expect(parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      query_probes: { ...baseDiagnostics.query_probes, normalized_query: null },
      answer_rerank_status: "not_applicable",
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true" }).answer_rerank_status).toBe(
      "not_applicable"
    );

    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      answer_rerank_status: "not_applicable",
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "true" })).toThrow(
      /non-empty query and candidate pool/u
    );

    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 1,
      answer_rerank_scored_count: 1,
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK: "false" })).toThrow(
      /cross-encoder control activation failed/u
    );
  });

  it("publishes treatment activation evidence on each question diagnostic", () => {
    const question = buildQuestionDiagnostic({
      questionId: "q-rerank-proof",
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
          ...baseDiagnostics,
          answer_rerank_status: "returned",
          answer_rerank_expected_count: 1,
          answer_rerank_scored_count: 1,
          candidates: [baseCandidate]
        }
      }
    });

    expect(question).toMatchObject({
      answer_rerank_status: "returned",
      answer_rerank_expected_count: 1,
      answer_rerank_scored_count: 1,
      answer_rerank_failure_class: null
    });
  });

  it("fails a bi-encoder treatment that did not scan stored local vectors", () => {
    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" })).toThrow(
      /bi-encoder treatment activation failed/u
    );

    expect(parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      embedding_provider_status: "provider_returned",
      embedding_workspace_scan_cap: 10_000,
      embedding_workspace_scanned_count: 1,
      embedding_workspace_truncated: false,
      embedding_workspace_provider_kind: "local_onnx",
      embedding_workspace_model_id: "Xenova/test",
      embedding_workspace_schema_version: 1,
      candidates: [{
        ...baseCandidate,
        score_factors: { embedding_similarity: 0.73 }
      }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "1" }).embedding_provider_status).toBe(
      "provider_returned"
    );

    expect(parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      embedding_provider_status: "provider_returned",
      candidates: [{
        ...baseCandidate,
        score_factors: { embedding_similarity: 0.73 }
      }]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true" }).embedding_provider_status).toBe(
      "provider_returned"
    );

    expect(() => parseBenchRecallDiagnosticsForRun({
      ...baseDiagnostics,
      embedding_provider_status: "provider_returned",
      embedding_workspace_scanned_count: 1,
      embedding_workspace_truncated: false,
      embedding_workspace_provider_kind: "local_onnx",
      embedding_workspace_model_id: "Xenova/test",
      embedding_workspace_schema_version: 1,
      candidates: [baseCandidate]
    }, { ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false" })).toThrow(
      /bi-encoder control activation failed/u
    );
  });
});
