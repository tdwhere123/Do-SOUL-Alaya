import { describe, expect, it } from "vitest";
import { completeAnswerFeatures, diagnostic } from "./evidence-contract-test-support.js";

describe("historical candidate evidence completeness", () => {
  it("retains complete archived baseline evidence without a live scorer", () => {
    const row = archivedQuestion();
    expect(row.candidate_pool_complete).toBe(true);
    expect(row.cohort_ledger?.evidence_status).toBe("complete");
  });

  it.each([
    { created_at: undefined },
    { per_stream_rank: null },
    { fused_rank_contribution_per_stream: null },
    { score_factors: {} }
  ])("does not certify missing historical observations: %j", (patch) => {
    const row = archivedQuestion(patch);
    expect(row.candidates).toHaveLength(1);
    expect(row.candidate_pool_complete).toBe(false);
    expect(row.cohort_ledger?.evidence_status).toBe("partial");
  });

  it.each([
    { fused_score: 0.7 },
    { answer_relevance_score: 0.7, deep_head_trace: trace("cross_encoder") },
    { answer_relevance_score: 0.7, deep_head_trace: trace("cross_encoder_unscored") }
  ])("does not certify contradictory archived score observations: %j", (patch) => {
    const row = archivedQuestion(patch);
    expect(row.candidates).toHaveLength(1);
    expect(row.candidate_pool_complete).toBe(false);
    expect(row.cohort_ledger?.evidence_status).toBe("partial");
  });
});

function archivedQuestion(patch: Readonly<Record<string, unknown>> = {}) {
  return diagnostic({ id: "archived-evidence", gold: ["gold-a"], recallResult: { diagnostics: {
    answer_shape_plan: { schema_version: 1, status: "unknown", shape: null,
      target_terms: [], relation_terms: [] },
    candidate_pool_count: 1, fine_assessment_pruned_candidates: [],
    token_economy: { fine_pruned_count: 0, fine_evaluated: 1, coarse_pool_size: 1 },
    candidates: [{ object_id: "gold-a", object_kind: "memory_entry",
      candidate_key: "workspace_local:memory_entry:gold-a", origin_plane: "workspace_local",
      created_at: "2026-07-11T00:00:00.000Z", per_stream_rank: { lexical_fts: 1 },
      fused_rank_contribution_per_stream: { lexical_fts: 0.5 }, score_factors: { activation: 0.5 },
      fused_score: 0.5, answer_relevance_score: null, answer_features: completeAnswerFeatures(),
      deep_head_trace: trace("field_baseline"), coverage_marginal_gain: 1, ...patch }]
  } } });
}

function trace(source: "field_baseline" | "cross_encoder" | "cross_encoder_unscored") {
  return { lexical_agreement: 0, evidence_agreement: 0, resolved_evidence: 0,
    embedding_signal: null, fusion_baseline_used: source === "field_baseline",
    resolved_score: source === "cross_encoder_unscored" ? 0 : 0.5, score_source: source };
}
