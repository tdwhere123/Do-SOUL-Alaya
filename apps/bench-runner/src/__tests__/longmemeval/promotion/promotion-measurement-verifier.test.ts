import { describe, expect, it } from "vitest";
import {
  applyQuestionMeasurementAxes,
  buildQuestionMeasurementAxes
} from "../../../longmemeval/diagnostics/diagnostics-measurement-axes.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../longmemeval/diagnostics/schema/diagnostics-types.js";
import { verifyPromotionQuestionMeasurement } from
  "../../../longmemeval/promotion/verifiers/measurement-verifier.js";
import type { SnapshotQuestionMeasurementOracle } from
  "../../../longmemeval/snapshot/measurement-oracle.js";
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
      oracle: oracle(measurement)
    }).status).toBe("evaluator_identity_unscorable");
  });

  it.each([
    ["candidate absence", { candidate_absent: 2, materialization_drop: 0 }, "candidate_absent"],
    ["materialization drop", { candidate_absent: 0, materialization_drop: 1 }, "materialization_drop"],
    ["both drop reasons", { candidate_absent: 2, materialization_drop: 1 }, "materialization_drop"]
  ] as const)("accepts an answer seed with %s", (_label, seedDropReasons, reason) => {
    const mutable = structuredClone(
      promotionMeasurementDiagnostic("q-seed-drop", "identity_unscorable", false)
    ) as unknown as MutableQuestion["diagnostics"];
    mutable.miss_classification = "no_gold";
    mutable.miss_taxonomy = reason === "materialization_drop"
      ? "materialization_drop"
      : "candidate_absent";
    mutable.seed_drop_reasons = seedDropReasons;
    mutable.cohort_ledger.extraction_materialization = {
      status: "drop", emitted_memory_count: 0, reason
    };
    mutable.cohort_ledger.evaluation_issue_reason = "extraction_materialization_drop";
    mutable.cohort_ledger.final_verdict = "evaluation_unscorable";
    const measurement = measurementPrimitives();
    const diagnostic = applyQuestionMeasurementAxes(
      mutable as unknown as LongMemEvalQuestionDiagnostic,
      buildQuestionMeasurementAxes(measurement)
    );

    expect(verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, seedDropReasons)
    }).status).toBe("evaluator_identity_unscorable");
  });

  it("rejects answer seed drop reasons that differ from the snapshot", () => {
    const diagnostic = seedDropDiagnostic();
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement)
    })).toThrow(/answer seed drop reasons differs/u);
  });

  it("rejects a ledger extraction tuple that differs from seed primitives", () => {
    const diagnostic = seedDropDiagnostic();
    diagnostic.cohort_ledger!.extraction_materialization = {
      status: "drop", emitted_memory_count: 0, reason: "materialization_drop"
    };
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/gold identity differs from snapshot/u);
  });

  it("rejects an abstention identity that differs from the snapshot", () => {
    const diagnostic = structuredClone(seedDropDiagnostic());
    diagnostic.is_abstention = true;
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/KPI row differs from snapshot abstention/u);
  });

  it("rejects premise-invalid rows from promotion evidence", () => {
    const diagnostic = structuredClone(seedDropDiagnostic());
    diagnostic.premise_invalid = true;
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/premise-invalid row is not promotion eligible/u);
  });

  it("rejects ambiguous evaluator identity from promotion evidence", () => {
    const diagnostic = structuredClone(seedDropDiagnostic());
    diagnostic.cohort_ledger!.evaluator_gold_identity.status = "ambiguous";
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/identity ambiguity is not promotion eligible/u);
  });
});

function seedDropDiagnostic(): LongMemEvalQuestionDiagnostic {
  const mutable = structuredClone(
    promotionMeasurementDiagnostic("q-seed-drop", "identity_unscorable", false)
  ) as unknown as MutableQuestion["diagnostics"];
  mutable.miss_classification = "no_gold";
  mutable.miss_taxonomy = "candidate_absent";
  mutable.seed_drop_reasons = { candidate_absent: 2, materialization_drop: 0 };
  mutable.cohort_ledger.extraction_materialization = {
    status: "drop", emitted_memory_count: 0, reason: "candidate_absent"
  };
  mutable.cohort_ledger.evaluation_issue_reason = "extraction_materialization_drop";
  mutable.cohort_ledger.final_verdict = "evaluation_unscorable";
  return applyQuestionMeasurementAxes(
    mutable as unknown as LongMemEvalQuestionDiagnostic,
    buildQuestionMeasurementAxes(measurementPrimitives())
  );
}

function oracle(
  measurement: ReturnType<typeof measurementPrimitives>,
  seedDropReasons = { candidate_absent: 0, materialization_drop: 0 }
): SnapshotQuestionMeasurementOracle {
  return {
    ...measurement,
    goldMemoryIds: [],
    seedDropReasons
  } as SnapshotQuestionMeasurementOracle;
}

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
