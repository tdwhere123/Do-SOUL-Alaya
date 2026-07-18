import { describe, expect, it } from "vitest";
import {
  applyQuestionMeasurementAxes,
  buildQuestionMeasurementAxes
} from "../../../longmemeval/diagnostics/diagnostics-measurement-axes.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../longmemeval/diagnostics/schema/diagnostics-types.js";
import { verifyPromotionQuestionMeasurement } from
  "../../../longmemeval/promotion/verifiers/measurement-verifier.js";
import { promotionMeasurementDiagnostic } from
  "../recall-eval/specialized-answerable-recall-fixture.js";
import type { MutableQuestion } from "./promotion-diagnostics-fixture.js";

describe("promotion measurement verifier", () => {
  it("accepts an answerable valid-negative with no evaluator gold", () => {
    const mutable = structuredClone(
      promotionMeasurementDiagnostic("q-no-gold", "identity_unscorable", false)
    ) as unknown as MutableQuestion["diagnostics"];
    mutable.miss_classification = "no_gold";
    mutable.miss_taxonomy = "evaluation_or_gold_issue";
    mutable.cohort_ledger.evaluation_issue_reason = "empty_gold_identity";
    mutable.cohort_ledger.final_verdict = "evaluation_unscorable";
    const measurement = measurementPrimitives();
    const diagnostic = applyQuestionMeasurementAxes(
      mutable as unknown as LongMemEvalQuestionDiagnostic,
      buildQuestionMeasurementAxes(measurement)
    );

    expect(verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: { ...measurement, goldMemoryIds: [] }
    }).status).toBe("evaluator_identity_unscorable");
  });
});

function measurementPrimitives() {
  return {
    answer: "Expected answer",
    answerSessionIds: ["answer-session"],
    sourceDatesBySession: new Map([["answer-session", "2026-07-18T00:00:00.000Z"]]),
    deliveredResults: [],
    candidates: [],
    sidecar: new Map(),
    isAbstention: false,
    evaluatorGoldMemoryIds: [],
    evaluatorHitAt5: false
  };
}
