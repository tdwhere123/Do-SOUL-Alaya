import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from "../../../bench/diagnostics.js";
import { reclassifyQuestionDiagnostic } from
  "../../../bench/diagnostics/miss/reclassify-question-diagnostics.js";
import {
  PLANTED_GOLD_ID,
  plantedCanonicalQuestion
} from "./planted-canonical-fixture.js";

describe("classifyMiss canonical ordering residual", () => {
  it("names an in-field canonical miss without fused_rank as under_ranked", () => {
    const row = plantedCanonicalQuestion({
      questionId: "q-planted-in-field-miss",
      fieldObjectIds: [PLANTED_GOLD_ID, "planted-a"],
      deliveredObjectIds: ["planted-a"]
    });

    expect(row.ranking_authority).toBe("prefix_sk");
    expect(row.gold[0]?.fused_rank).toBeNull();
    expect(row.gold[0]?.pre_budget_rank).toBeNull();
    expect(row.gold[0]?.candidate_status).toBe("candidate_not_delivered");
    expect(row.miss_classification).toBe("under_ranked");
    expect(row.miss_taxonomy).toBe("delivery_order_drop");
    expect(row.miss_classification).not.toBe("candidate_absent");
  });

  it("does not call in-field golds with both planes a lexical or structural gap", () => {
    const row = plantedCanonicalQuestion({
      questionId: "q-planted-both-planes",
      fieldObjectIds: [PLANTED_GOLD_ID],
      deliveredObjectIds: [],
      goldAdmissionPlanes: ["lexical", "facet_concept"]
    });

    expect(row.gold[0]?.source_planes).toEqual(
      expect.arrayContaining(["lexical", "facet_concept"])
    );
    expect(row.miss_classification).toBe("under_ranked");
    expect(row.miss_taxonomy).toBe("delivery_order_drop");
    expect(row.miss_classification).not.toBe("lexical_gap");
    expect(row.miss_classification).not.toBe("structural_gap");
    expect(row.miss_classification).not.toBe("candidate_absent");
  });

  it("keeps true field absence as candidate_absent", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-planted-field-absent",
      goldMemoryIds: [PLANTED_GOLD_ID],
      answerSessionIds: ["session-planted"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        ranking_authority: "prefix_sk",
        diagnostics: { candidates: [] }
      }
    });

    expect(row.gold[0]?.candidate_status).toBe("candidate_absent");
    expect(row.miss_classification).toBe("candidate_absent");
    expect(row.miss_taxonomy).toBe("candidate_absent");
  });

  it("joins e0_keys when the gold row is omitted from candidates", () => {
    const row = plantedCanonicalQuestion({
      questionId: "q-planted-e0-only",
      fieldObjectIds: [PLANTED_GOLD_ID, "planted-a"],
      deliveredObjectIds: ["planted-a"],
      includeGoldCandidateRow: false
    });

    expect(row.gold[0]?.candidate_status).toBe("candidate_absent");
    expect(row.capture_receipt?.field_membership.e0_keys).toEqual(
      expect.arrayContaining([`workspace_local:memory_entry:${PLANTED_GOLD_ID}`])
    );
    expect(row.miss_classification).toBe("under_ranked");
    expect(row.miss_taxonomy).toBe("delivery_order_drop");
  });

  it("keeps legacy fused_rank / pre_budget_rank budget and ordering labels", () => {
    const budgetDropped = buildQuestionDiagnostic({
      questionId: "q-legacy-budget",
      goldMemoryIds: [PLANTED_GOLD_ID],
      answerSessionIds: ["session-planted"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        ranking_authority: "select_gamma",
        diagnostics: {
          candidate_pool: [{
            object_id: PLANTED_GOLD_ID,
            final_rank: null,
            pre_budget_rank: 4,
            fused_rank: 4,
            budget_drop_reason: "max_entries"
          }]
        }
      }
    });
    const underRanked = buildQuestionDiagnostic({
      questionId: "q-legacy-under-ranked",
      goldMemoryIds: [PLANTED_GOLD_ID],
      answerSessionIds: ["session-planted"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        ranking_authority: "select_gamma",
        diagnostics: {
          candidate_pool: [{
            object_id: PLANTED_GOLD_ID,
            final_rank: null,
            pre_budget_rank: 16,
            fused_rank: 16,
            budget_drop_reason: "max_entries"
          }]
        }
      }
    });

    expect(budgetDropped.miss_classification).toBe("budget_dropped");
    expect(budgetDropped.miss_taxonomy).toBe("budget_drop");
    expect(underRanked.miss_classification).toBe("under_ranked");
    expect(underRanked.miss_taxonomy).toBe("delivery_order_drop");
  });

  it("reclassifies a stored canonical miss without re-running recall", () => {
    const stored = plantedCanonicalQuestion({
      questionId: "q-planted-stored",
      fieldObjectIds: [PLANTED_GOLD_ID],
      deliveredObjectIds: [],
      goldAdmissionPlanes: ["lexical", "facet_concept"]
    });
    const lying = {
      ...stored,
      miss_classification: "candidate_absent" as const
    };

    const repaired = reclassifyQuestionDiagnostic(lying);
    expect(repaired.miss_classification).toBe("under_ranked");
    expect(repaired.miss_taxonomy).toBe("delivery_order_drop");
    expect(repaired.gold[0]?.miss_taxonomy).toBe("delivery_order_drop");
  });
});
