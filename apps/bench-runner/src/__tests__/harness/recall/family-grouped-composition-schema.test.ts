import { describe, expect, it } from "vitest";
import { FAMILY_GROUPED_COMPOSITION_OPERATOR_ID } from "@do-soul/alaya-core";
import { RecallDeepHeadTraceSchema } from
  "../../../harness/recall/answer-trace-schema.js";

describe("family-grouped deep-head trace schema", () => {
  it("recomposes family_grouped_composition_v1 from per-family receipts", () => {
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0.5,
      evidence_agreement: 0.4,
      resolved_evidence: 0.5,
      embedding_signal: 0.4,
      fusion_baseline_used: true,
      resolved_score: 0.9,
      score_source: "fusion_embedding_evidence",
      formula_operator_id: FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
      family_scores: {
        lexical_evidence: 0.5,
        semantic: 0.4,
        fusion: 0.2
      }
    }).success).toBe(true);
  });

  it("rejects a noisy-OR score under the family-grouped operator", () => {
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: 0.4,
      fusion_baseline_used: true,
      resolved_score: 0.52,
      score_source: "fusion_embedding_evidence",
      formula_operator_id: FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
      family_scores: {
        lexical_evidence: 0,
        semantic: 0.4,
        fusion: 0.2
      }
    }).success).toBe(false);
  });

  it("still accepts pre-family-receipt probabilistic-or traces", () => {
    expect(RecallDeepHeadTraceSchema.safeParse({
      lexical_agreement: 0,
      evidence_agreement: 0,
      resolved_evidence: 0,
      embedding_signal: 0.4,
      fusion_baseline_used: true,
      resolved_score: 0.52,
      score_source: "fusion_embedding_evidence",
      formula_operator_id: "lightweight_deep_head_prob_or_v1"
    }).success).toBe(true);
  });
});
