import { describe, expect, it } from "vitest";
import type {
  LongMemEvalQuestionDiagnostic
} from "../../../bench/diagnostics/schema/diagnostics-types.js";
import { pairMechanismQuestions } from
  "../../../bench/diagnostics/stage-attribution/mechanism/from-question-diagnostics.js";
import { buildRecallMechanismSplit } from
  "../../../bench/diagnostics/stage-attribution/mechanism/receipt.js";

function arm(
  questionId: string,
  variant: "control" | "treatment"
): LongMemEvalQuestionDiagnostic {
  const candidateKey = "candidate-gold";
  const isTreatment = variant === "treatment";
  return {
    question_id: questionId,
    hit_at_5: isTreatment,
    query_open_semantic_factor_formation: { status: isTreatment ? "formed" : "ineligible" },
    open_semantic_factor_compatibility_trace: {
      incomparable_seal: "none",
      entries: [{ receipt: { status: isTreatment ? "compatible" : "incompatible" } }]
    },
    open_semantic_factor_composition: {
      solutions: isTreatment ? [{ evidence_ids: ["e1"] }] : []
    },
    open_semantic_factor_activation: {
      status: "composed",
      entries: isTreatment ? [{ activation: 0.8 }] : [{ activation: 0.2 }]
    },
    open_semantic_factor_candidate_activations: [{
      candidate_key: candidateKey,
      receipt: { score: isTreatment ? 0.8 : 0.2 }
    }],
    candidates: [{ object_id: "gold-1", candidate_key: candidateKey }],
    gold: [{
      object_id: "gold-1",
      candidate_status: isTreatment ? "candidate_not_delivered" : "delivered",
      fused_rank: 3,
      budget_drop_reason: isTreatment ? "duplicate" : null,
      select_gamma_decision: isTreatment
        ? { kind: "duplicate", identity_channel: "object" }
        : { kind: "retained" }
    }]
  } as unknown as LongMemEvalQuestionDiagnostic;
}

describe("recall mechanism diagnostics adapter", () => {
  it("projects persisted OSF fields and Select_Gamma identity receipts", () => {
    const questions = pairMechanismQuestions(
      [arm("q1", "control")],
      [arm("q1", "treatment")]
    );
    const question = questions[0]!;
    expect(question.field_member).toEqual({ control: false, treatment: true });
    expect(question.compatibility).toEqual({ control: false, treatment: true });
    expect(question.binding_solutions?.treatment).toHaveLength(1);
    expect(question.activation).toEqual({ control: 0.2, treatment: 0.8 });
    expect(question.golds?.[0]?.prefix_eligible).toBe(true);
    expect(question.golds?.[0]?.activation).toEqual({ control: 0.2, treatment: 0.8 });
    const receipt = buildRecallMechanismSplit({ questions });
    expect(receipt.gold_exclusions).toEqual([{
      question_id: "q1",
      gold_key: "gold-1",
      first_reason: "duplicate_object",
      outcome: "excluded"
    }]);
  });
});
