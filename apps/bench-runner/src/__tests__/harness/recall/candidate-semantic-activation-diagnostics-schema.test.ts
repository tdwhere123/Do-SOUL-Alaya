import { describe, expect, it } from "vitest";
import { parseBenchRecallDiagnosticsForRun } from
  "../../../harness/recall/recall-diagnostics-schema.js";
import { buildQuestionDiagnostic } from
  "../../../diagnostics/diagnostics-question.js";

const FUSION_STREAMS = [
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
  "workspace_activation"
] as const;

const osfWinnerReceipt = Object.freeze({
  schema_version: 1 as const,
  operator_id: "candidate_semantic_max_v1",
  state: "observed" as const,
  score: 1,
  winner: Object.freeze({ channel: "open_semantic_solution", score: 1 }),
  observations: Object.freeze([
    Object.freeze({ channel: "evidence_semantic", state: "absent" as const, score: null }),
    Object.freeze({
      channel: "open_semantic_solution",
      state: "observed" as const,
      score: 1
    }),
    Object.freeze({ channel: "effective_factor", state: "absent" as const, score: null }),
    Object.freeze({ channel: "object_embedding", state: "absent" as const, score: null })
  ]),
  missing_channel_policy: "no_op" as const
});

describe("candidate semantic activation diagnostic schema", () => {
  it("keeps older candidate dumps valid without semantic_activation", () => {
    const parsed = parseBenchRecallDiagnosticsForRun(diagnosticsWithCandidate({}));
    expect(parsed.candidates[0]).not.toHaveProperty("semantic_activation");
    expect(parsed.candidates[0]?.per_stream_rank.embedding_similarity).toBe(1);
  });

  it("accepts an OSF winner on embedding_similarity without renaming the stream", () => {
    const parsed = parseBenchRecallDiagnosticsForRun(diagnosticsWithCandidate({
      semantic_activation: osfWinnerReceipt
    }));
    const candidate = parsed.candidates[0];

    expect(candidate?.semantic_activation?.winner?.channel).toBe(
      "open_semantic_solution"
    );
    expect(candidate?.per_stream_rank.embedding_similarity).toBe(1);
    expect(candidate?.fused_rank).toBe(1);
    expect(candidate?.fused_score).toBe(0.81);
  });

  it("archives that OSF winner on the question-diagnostic candidate mirror", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q1",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: diagnosticsWithCandidate({
        semantic_activation: osfWinnerReceipt
      }) }
    });

    expect(row.candidates[0]?.semantic_activation?.winner?.channel).toBe(
      "open_semantic_solution"
    );
    expect(row.candidates[0]?.per_stream_rank?.embedding_similarity).toBe(1);
  });

  it("rejects an observed receipt that cannot name a winner", () => {
    expect(() => parseBenchRecallDiagnosticsForRun(diagnosticsWithCandidate({
      semantic_activation: {
        ...osfWinnerReceipt,
        winner: null
      }
    }))).toThrow(/activation state must agree with winner and score/u);
  });

  it("rejects a candidate activation receipt with a forged operator id", () => {
    expect(() => parseBenchRecallDiagnosticsForRun(diagnosticsWithCandidate({
      semantic_activation: {
        ...osfWinnerReceipt,
        operator_id: "forged_operator"
      }
    }))).toThrow(/candidate_semantic_max_v1/u);
  });
});

function diagnosticsWithCandidate(candidateFields: Record<string, unknown>) {
  return {
    query_probes: {
      normalized_query: "where did they go",
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
    },
    total_scanned: 1,
    candidate_pool_count: 1,
    pre_budget_count: 1,
    delivered_count: 1,
    embedding_provider_status: "provider_not_requested",
    embedding_supplement_status: "disabled",
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
    fusion_breakdown: [],
    fine_assessment_pruned_candidates: [],
    candidates: [{
      candidate_key: "workspace_local:memory_entry:q1-gold",
      object_id: "q1-gold",
      object_kind: "memory_entry",
      origin_plane: "workspace_local",
      admission_planes: ["activation"],
      plane_first_admitted: "activation",
      plane_winning_admission: "activation",
      pre_budget_rank: 1,
      selection_order: 1,
      fused_rank: 1,
      fused_score: 0.81,
      per_stream_rank: {
        ...Object.fromEntries(FUSION_STREAMS.map((key) => [key, null])),
        embedding_similarity: 1
      },
      fused_rank_contribution_per_stream: {
        ...Object.fromEntries(FUSION_STREAMS.map((key) => [key, 0])),
        embedding_similarity: 0.42
      },
      final_rank: 1,
      dropped_reason: null,
      within_budget: true,
      relevance_score: 0.81,
      lexical_rank: null,
      structural_score: 0,
      score_factors: {},
      source_channels: ["workspace_local"],
      path_expansion_sources: [],
      ...candidateFields
    }]
  };
}
