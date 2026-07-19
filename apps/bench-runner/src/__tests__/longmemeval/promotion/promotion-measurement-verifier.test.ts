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

type DiagnosticOverrides = Partial<Pick<LongMemEvalQuestionDiagnostic,
  "is_abstention" | "miss_classification" | "miss_taxonomy" |
  "premise_invalid" | "seed_drop_reasons"
>>;
type CohortLedger = NonNullable<LongMemEvalQuestionDiagnostic["cohort_ledger"]>;
type CohortLedgerOverrides = Partial<Pick<CohortLedger,
  "evaluation_issue_reason" | "evaluator_gold_identity" |
  "extraction_materialization" | "final_verdict" | "measurement_status" |
  "retrieval_status"
>>;

describe("promotion measurement verifier", () => {
  it("accepts an answerable valid-negative with no evaluator gold", () => {
    const measurement = measurementPrimitives();
    const diagnostic = applyQuestionMeasurementAxes(
      withDiagnosticOverrides(
        promotionMeasurementDiagnostic("q-no-gold", "identity_unscorable", false),
        {
          miss_classification: "no_gold",
          miss_taxonomy: "evaluation_or_gold_issue"
        },
        {
          evaluation_issue_reason: "empty_gold_identity",
          final_verdict: "evaluation_unscorable"
        }
      ),
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
  ] as const)("scores an answer seed with %s as a verified miss", (
    _label,
    seedDropReasons,
    reason
  ) => {
    const measurement = measurementPrimitives();
    const diagnostic = applyQuestionMeasurementAxes(
      withDiagnosticOverrides(
        promotionMeasurementDiagnostic("q-seed-drop", "identity_unscorable", false),
        {
          miss_classification: "candidate_absent",
          miss_taxonomy: reason === "materialization_drop"
            ? "materialization_drop"
            : "candidate_absent",
          seed_drop_reasons: seedDropReasons
        },
        {
          extraction_materialization: {
            status: "drop", emitted_memory_count: 0, reason
          },
          evaluation_issue_reason: "extraction_materialization_drop",
          measurement_status: "scorable",
          retrieval_status: "miss_at_5",
          final_verdict: "miss_at_5"
        }
      ),
      buildQuestionMeasurementAxes(measurement)
    );

    expect(verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, seedDropReasons)
    })).toMatchObject({ status: "scorable", scorable: true, hits: {
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    } });
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
    const diagnostic = withDiagnosticOverrides(seedDropDiagnostic(), {}, {
      extraction_materialization: {
        status: "drop", emitted_memory_count: 0, reason: "materialization_drop"
      }
    });
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/gold identity differs from snapshot/u);
  });

  it("rejects an abstention identity that differs from the snapshot", () => {
    const diagnostic = withDiagnosticOverrides(seedDropDiagnostic(), {
      is_abstention: true
    });
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/KPI row differs from snapshot abstention/u);
  });

  it("rejects premise-invalid rows from promotion evidence", () => {
    const diagnostic = withDiagnosticOverrides(seedDropDiagnostic(), {
      premise_invalid: true
    });
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/premise-invalid row is not promotion eligible/u);
  });

  it("rejects ambiguous evaluator identity from promotion evidence", () => {
    const base = seedDropDiagnostic();
    const ledger = requireCohortLedger(base);
    const diagnostic = withDiagnosticOverrides(base, {}, {
      evaluator_gold_identity: {
        ...ledger.evaluator_gold_identity,
        status: "ambiguous"
      },
      measurement_status: "evaluator_identity_unscorable"
    });
    const measurement = measurementPrimitives();

    expect(() => verifyPromotionQuestionMeasurement({
      diagnostic,
      expectedGold: [],
      oracle: oracle(measurement, { candidate_absent: 2, materialization_drop: 0 })
    })).toThrow(/identity ambiguity is not promotion eligible/u);
  });
});

function seedDropDiagnostic(): LongMemEvalQuestionDiagnostic {
  const diagnostic = withDiagnosticOverrides(
    promotionMeasurementDiagnostic("q-seed-drop", "identity_unscorable", false),
    {
      miss_classification: "candidate_absent",
      miss_taxonomy: "candidate_absent",
      seed_drop_reasons: { candidate_absent: 2, materialization_drop: 0 }
    },
    {
      extraction_materialization: {
        status: "drop", emitted_memory_count: 0, reason: "candidate_absent"
      },
      evaluation_issue_reason: "extraction_materialization_drop",
      measurement_status: "scorable",
      retrieval_status: "miss_at_5",
      final_verdict: "miss_at_5"
    }
  );
  return applyQuestionMeasurementAxes(
    diagnostic,
    buildQuestionMeasurementAxes(measurementPrimitives())
  );
}

function withDiagnosticOverrides(
  diagnostic: LongMemEvalQuestionDiagnostic,
  overrides: DiagnosticOverrides = {},
  cohortLedgerOverrides: CohortLedgerOverrides = {}
): LongMemEvalQuestionDiagnostic {
  return {
    ...diagnostic,
    ...overrides,
    cohort_ledger: {
      ...requireCohortLedger(diagnostic),
      ...cohortLedgerOverrides
    }
  };
}

function requireCohortLedger(
  diagnostic: LongMemEvalQuestionDiagnostic
): CohortLedger {
  if (diagnostic.cohort_ledger === undefined) {
    throw new Error("promotion measurement fixture requires a cohort ledger");
  }
  return diagnostic.cohort_ledger;
}

function oracle(
  measurement: ReturnType<typeof measurementPrimitives>,
  seedDropReasons = { candidate_absent: 0, materialization_drop: 0 }
): SnapshotQuestionMeasurementOracle {
  return {
    ...measurement,
    goldMemoryIds: [],
    seedDropReasons
  };
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
