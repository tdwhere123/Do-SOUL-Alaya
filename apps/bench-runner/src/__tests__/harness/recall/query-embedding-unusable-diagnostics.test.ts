import { describe, expect, it } from "vitest";
import { parseBenchRecallDiagnosticsForRun } from
  "../../../harness/recall/recall-diagnostics-schema.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../bench/diagnostics/schema/diagnostics-schema.js";
import {
  buildQuestionDiagnostic,
  summarizeProviderStates
} from "../../../bench/diagnostics.js";

const unusableReadyDiagnostics = {
  query_probes: {
    normalized_query: "question",
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
  total_scanned: 0,
  candidate_pool_count: 0,
  pre_budget_count: 0,
  delivered_count: 0,
  embedding_provider_status: "query_embedding_unusable",
  provider_degradation_reason: "query_embedding_unusable",
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
  candidates: [],
  fine_assessment_pruned_candidates: []
};

describe("query_embedding_unusable diagnostic round-trip", () => {
  it("parses an unusable-ready producer status through bench dump and provider summary", () => {
    const parsed = parseBenchRecallDiagnosticsForRun(unusableReadyDiagnostics);
    expect(parsed.embedding_provider_status).toBe("query_embedding_unusable");

    const question = buildQuestionDiagnostic({
      questionId: "q-unusable-ready",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: { diagnostics: parsed }
    });
    const dumped = LongMemEvalQuestionDiagnosticSchema.parse(question);

    expect(dumped.provider_state).toBe("query_embedding_unusable");
    expect(dumped.provider_degradation_reason).toBe("query_embedding_unusable");

    const summary = summarizeProviderStates([dumped]);
    expect(summary.query_embedding_unusable).toBe(1);
    expect(summary.query_embedding_unusable_rate).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.provider_failed).toBe(0);
    expect(summary.provider_returned).toBe(0);
  });
});
