// @ts-nocheck
import { describe, expect, it } from "vitest";
import { buildTreatmentExposureReceipts } from
  "../../../../diagnostics/stage-attribution/exposure/build-receipts.js";
import { assertTreatmentExposureReceipt } from
  "../../../../diagnostics/stage-attribution/exposure/contract.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../../diagnostics/schema/diagnostics-types.js";
import type { QuestionStageRow } from
  "../../../../diagnostics/stage-attribution/types.js";

describe("sealed exposure receipt phase ledger", () => {
  it("persists ranking-only, silent prune, and empty-pack delivery authority", () => {
    const ranking = arm({
      questionId: "q-rank",
      candidates: [{ candidate_key: "candidate:a", final_rank: 1 }]
    });
    const [rankingReceipt] = receipts(ranking, ranking);
    expect(rankingReceipt.product_phase_ledger.selection.authority).toBe("not_observed");
    expect(rankingReceipt.product_phase_ledger.delivery).toEqual({
      phase: "delivery", status: null, authority: "not_observed"
    });
    expect(() => assertTreatmentExposureReceipt(rankingReceipt)).not.toThrow();

    const pruned = arm({
      questionId: "q-prune",
      candidates: [{ candidate_key: "candidate:a", final_rank: 1 }],
      pruned: [{ candidate_key: "candidate:dropped" }]
    });
    const [prunedReceipt] = receipts(pruned, pruned);
    expect(prunedReceipt.product_phase_ledger.delivery.authority).toBe("not_observed");

    const empty = arm({
      questionId: "q-empty",
      candidates: [{
        candidate_key: "candidate:a",
        selection_order: 1,
        admission_attempts: [{ admitted: true }]
      }],
      delivered: []
    });
    const [emptyReceipt] = receipts(empty, empty);
    expect(emptyReceipt.product_phase_ledger.delivery).toEqual({
      phase: "delivery", status: "not_delivered", authority: "product"
    });
  });

  it("fail-closes a product activation that has no selection observation", () => {
    const treatment = arm({
      questionId: "q-silent",
      candidates: [{ candidate_key: "candidate:a", final_rank: 1 }],
      activation: "composed"
    });
    expect(() => receipts(treatment, treatment))
      .toThrow(/no explicit selection observation/u);
  });
});

function receipts(
  control: LongMemEvalQuestionDiagnostic,
  treatment: LongMemEvalQuestionDiagnostic
) {
  return buildTreatmentExposureReceipts({
    control: [control],
    treatment: [treatment],
    controlStages: [stage(control.question_id)],
    treatmentStages: [stage(treatment.question_id)]
  });
}

function arm(input: {
  readonly questionId: string;
  readonly candidates: readonly Record<string, unknown>[];
  readonly delivered?: readonly unknown[];
  readonly pruned?: readonly unknown[];
  readonly activation?: "composed";
}): LongMemEvalQuestionDiagnostic {
  return {
    question_id: input.questionId,
    candidate_pool_complete: true,
    candidates: input.candidates,
    delivered_results: input.delivered,
    fine_assessment_pruned_candidates: input.pruned,
    open_semantic_factor_activation: input.activation === undefined
      ? undefined
      : { status: input.activation },
    open_semantic_factor_candidate_activations: []
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function stage(questionId: string): QuestionStageRow {
  return {
    question_id: questionId,
    stage: "delivered_top5",
    mechanism: null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: null,
    best_pool_rank: null,
    hit_at_5: false,
    proof: "budget_drop"
  };
}
