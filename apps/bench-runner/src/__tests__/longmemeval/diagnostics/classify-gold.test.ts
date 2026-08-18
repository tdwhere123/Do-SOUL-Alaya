import { describe, expect, it } from "vitest";
import { classifyGoldObjectStage } from "../../../bench/diagnostics/stage-attribution/classify-gold.js";
import { classifyQuestionStage } from
  "../../../bench/diagnostics/stage-attribution/classify-question.js";
import {
  buildGoldDiagnostic,
  buildQuestionDiagnosticFixture
} from "./gold-diagnostic-fixture.js";

function classifyAdmissionRefusal(input: {
  readonly objectId: string;
  readonly preBudgetRank: number;
  readonly dropReason: "ineligible" | "duplicate";
}) {
  const gold = buildGoldDiagnostic({
    object_id: input.objectId,
    object_kind: "memory_entry",
    candidate_status: "candidate_not_delivered",
    final_rank: null,
    pre_budget_rank: input.preBudgetRank,
    fused_rank: input.preBudgetRank,
    rank_after_fusion: input.preBudgetRank,
    rank_after_feature_rerank: input.preBudgetRank,
    rank_after_coverage_selector: input.preBudgetRank,
    coverage_selector_action: "kept",
    budget_drop_reason: input.dropReason,
    miss_taxonomy: "delivery_order_drop"
  });
  const question = Object.freeze({
    ...buildQuestionDiagnosticFixture({
      questionId: `q-${input.dropReason}`,
      gold: [gold]
    }),
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "delivery_order_drop" as const
  });
  return {
    gold: classifyGoldObjectStage({
      question,
      gold,
      opportunityQuestion: true
    }),
    question: classifyQuestionStage(question)
  };
}

describe("classifyGoldObjectStage admission refusals", () => {
  it("attributes coverage-kept ineligible rank 1 to admission", () => {
    const rows = classifyAdmissionRefusal({
      objectId: "g-ineligible",
      preBudgetRank: 1,
      dropReason: "ineligible"
    });
    expect(rows.gold.miss_taxonomy).toBe("delivery_order_drop");
    expect(rows.gold.stage).toBe(5);
    expect(rows.gold.mechanism).toBe("coverage_admission");
    expect(rows.gold.proof).toBe("delivery_admission_refusal");
    expect(rows.question.stage).toBe(5);
    expect(rows.question.mechanism).toBe("coverage_admission");
    expect(rows.question.proof).toBe("delivery_admission_refusal");
  });

  it("attributes duplicate rank 9 to admission", () => {
    const rows = classifyAdmissionRefusal({
      objectId: "g-duplicate",
      preBudgetRank: 9,
      dropReason: "duplicate"
    });
    expect(rows.gold.miss_taxonomy).toBe("delivery_order_drop");
    expect(rows.gold.stage).toBe(5);
    expect(rows.gold.mechanism).toBe("coverage_admission");
    expect(rows.gold.proof).toBe("delivery_admission_refusal");
    expect(rows.question.stage).toBe(5);
    expect(rows.question.proof).toBe("delivery_admission_refusal");
  });
});
