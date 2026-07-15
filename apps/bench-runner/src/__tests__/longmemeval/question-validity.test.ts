import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from "../../longmemeval/measurement/question-validity.js";
import {
  deriveQuestionMeasurementStatus as deriveTsQuestionMeasurementStatus,
  validateQuestionMeasurementStatus as validateTsQuestionMeasurementStatus,
  type QuestionMeasurementPrimitiveLedger,
  type QuestionMeasurementStatus
} from "../../longmemeval/measurement/question-measurement-status.js";
import { deriveQuestionMeasurementStatus as deriveReplayQuestionMeasurementStatus, isScorableMeasurementCohort, measurementUnscorableReason, validateQuestionMeasurementStatus as validateReplayQuestionMeasurementStatus } from "../../../scripts/longmemeval-replay/measurement-status.mjs";

function diagnostic(cohort: Record<string, unknown>): LongMemEvalQuestionDiagnostic {
  return {
    is_abstention: false,
    cohort_ledger: cohort
  } as unknown as LongMemEvalQuestionDiagnostic;
}

function abstentionDiagnostic(
  cohort: Record<string, unknown>
): LongMemEvalQuestionDiagnostic {
  return { ...diagnostic(cohort), is_abstention: true };
}

describe("question measurement validity", () => {
  it("derives the explicit primitive-axis truth table through both entry points", () => {
    const observed = new Set<QuestionMeasurementStatus>();
    for (const { name, input, expected } of MEASUREMENT_STATUS_CASES) {
      const context = `${name}: ${JSON.stringify(input)}`;
      expect(deriveTsQuestionMeasurementStatus(input), context).toBe(expected);
      expect(deriveReplayQuestionMeasurementStatus(input), context).toBe(expected);
      observed.add(expected);
    }
    expect([...observed].sort()).toEqual([
      "abstention_unscorable",
      "evaluator_identity_unscorable",
      "scorable"
    ]);
  });

  it("accepts only persisted statuses derived from the same primitive axes", () => {
    for (const { name, input, expected } of MEASUREMENT_STATUS_CASES) {
      for (const persisted of MEASUREMENT_STATUSES) {
        const withPersisted = withPersistedStatus(input, persisted);
        if (persisted === expected) {
          expect(validateTsQuestionMeasurementStatus(withPersisted), name).toBe(expected);
          expect(validateReplayQuestionMeasurementStatus(withPersisted), name).toBe(expected);
        } else {
          expect(() => validateTsQuestionMeasurementStatus(withPersisted))
            .toThrow(/measurement status contradicts primitive axes/u);
          expect(() => validateReplayQuestionMeasurementStatus(withPersisted))
            .toThrow(/measurement status contradicts primitive axes/u);
        }
      }
    }
  });

  it.each([
    ["dataset cohort", { dataset_cohort: "other" }, /dataset_cohort/u],
    ["persisted status", { measurement_status: "other" }, /measurement_status/u],
    ["identity status", {
      evaluator_gold_identity: { status: "other", object_ids: [] }
    }, /evaluator_gold_identity\.status/u],
    ["materialization status", {
      extraction_materialization: { status: "other" }
    }, /extraction_materialization\.status/u],
    ["issue type", { evaluation_issue_reason: 42 }, /evaluation_issue_reason/u],
    ["issue value", { evaluation_issue_reason: "other" }, /evaluation_issue_reason/u]
  ])("rejects an invalid %s primitive at the runtime boundary", (_label, cohort, error) => {
    expect(() => validateReplayQuestionMeasurementStatus({
      isAbstention: false,
      cohortLedger: { ...validAnswerableLedger(), ...cohort }
    } as unknown as StatusInput)).toThrow(error);
  });

  it("does not treat unknown materialization as positive scorable evidence", () => {
    const ledger = {
      ...validAnswerableLedger(),
      extraction_materialization: {
        status: "unknown" as const,
        emitted_memory_count: 0,
        reason: null
      }
    };

    expect(deriveReplayQuestionMeasurementStatus({
      isAbstention: false,
      cohortLedger: ledger
    })).toBe("evaluator_identity_unscorable");
  });

  it.each([
    ["zero emitted count", { status: "memory_emitted", emitted_memory_count: 0, reason: null }],
    ["emitted reason", {
      status: "memory_emitted", emitted_memory_count: 1, reason: "materialization_drop"
    }],
    ["emitted count mismatch", {
      status: "memory_emitted", emitted_memory_count: 2, reason: null
    }],
    ["unknown emitted count", { status: "unknown", emitted_memory_count: 1, reason: null }],
    ["unknown reason", {
      status: "unknown", emitted_memory_count: 0, reason: "candidate_absent"
    }],
    ["drop emitted count", {
      status: "drop", emitted_memory_count: 1, reason: "materialization_drop"
    }],
    ["drop without reason", { status: "drop", emitted_memory_count: 0, reason: null }]
  ])("rejects a contradictory materialization tuple: %s", (_label, extraction_materialization) => {
    expect(() => validateReplayQuestionMeasurementStatus({
      isAbstention: false,
      cohortLedger: { ...validAnswerableLedger(), extraction_materialization }
    } as StatusInput)).toThrow(/extraction_materialization/u);
  });

  it.each([
    "dataset_cohort",
    "evaluator_gold_identity",
    "extraction_materialization",
    "evaluation_issue_reason"
  ] as const)("rejects a missing current %s primitive", (field) => {
    const cohort = { ...validAnswerableLedger() } as Record<string, unknown>;
    delete cohort[field];

    expect(() => validateReplayQuestionMeasurementStatus({
      isAbstention: false,
      cohortLedger: cohort
    } as unknown as StatusInput)).toThrow(new RegExp(field, "u"));
  });

  it.each([
    ["plain-id", true, "abstention", "dataset_declared_abstention"],
    ["looks_abs", false, "answerable", "answerable"]
  ] as const)("uses the persisted cohort ledger for %s", (
    questionId,
    isAbstention,
    datasetCohort,
    expected
  ) => {
    const row = {
      ...diagnostic({ dataset_cohort: datasetCohort }),
      question_id: questionId,
      is_abstention: isAbstention
    } as LongMemEvalQuestionDiagnostic;

    expect(classifyQuestionMeasurementCohort(row)).toBe(expected);
  });

  it("refuses to synthesize a current cohort without a persisted ledger", () => {
    expect(() => classifyQuestionMeasurementCohort({
      ...diagnostic({}),
      question_id: "legacy_abs",
      is_abstention: true,
      cohort_ledger: undefined
    } as LongMemEvalQuestionDiagnostic)).toThrow(/cohort ledger/u);
  });

  it("keeps adjudicated dataset issues visible outside the recall denominator", () => {
    const row = {
      ...diagnostic({
        dataset_cohort: "adjudicated_invalid",
        measurement_status: "evaluator_identity_unscorable",
        evaluator_gold_identity: { status: "absent", object_ids: [] },
        extraction_materialization: {
          status: "unknown", emitted_memory_count: 0, reason: null
        },
        evaluation_issue_reason: "adjudicated_dataset_issue"
      }),
      question_id: "dataset-issue"
    } as LongMemEvalQuestionDiagnostic;

    expect(classifyQuestionMeasurementCohort(row)).toBe("answerable");
    expect(classifyQuestionMeasurementStatus(row)).toBe("evaluator_identity_unscorable");
  });

  it.each([
    ["answerable ledger over stale abstention flag", true, {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: {
        status: "memory_emitted", emitted_memory_count: 1, reason: null
      },
      evaluation_issue_reason: null
    }, "scorable", null],
    ["abstention ledger over stale answerable flag", false, {
      dataset_cohort: "abstention",
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      extraction_materialization: {
        status: "unknown", emitted_memory_count: 0, reason: null
      },
      evaluation_issue_reason: null
    }, "abstention_unscorable", "abstention_unscorable"],
    ["answerable no-gold row", false, {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: [] },
      extraction_materialization: {
        status: "unknown", emitted_memory_count: 0, reason: null
      },
      evaluation_issue_reason: null
    }, "evaluator_identity_unscorable", "evaluator_identity_unscorable"],
  ] as const)("keeps TS and MJS current validity aligned for %s", (
    _label,
    isAbstention,
    cohort,
    expectedStatus,
    expectedReplayReason
  ) => {
    const row = {
      ...diagnostic(cohort),
      is_abstention: isAbstention
    } as LongMemEvalQuestionDiagnostic;
    const status = classifyQuestionMeasurementStatus(row);
    expect(status).toBe(expectedStatus);
    expect(status === "scorable").toBe(isScorableMeasurementCohort(cohort));
    if (expectedReplayReason !== null) {
      expect(measurementUnscorableReason(cohort)).toBe(expectedReplayReason);
    }
  });

  it("rejects a forged persisted status at the TS classifier seam", () => {
    expect(() => classifyQuestionMeasurementStatus(diagnostic({
      measurement_status: "evaluator_identity_unscorable",
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: {
        status: "memory_emitted", emitted_memory_count: 1, reason: null
      },
      evaluation_issue_reason: null
    }))).toThrow(/measurement status contradicts primitive axes/u);
  });

  it.each([
    ["no gold object IDs", {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: [] },
      extraction_materialization: {
        status: "unknown", emitted_memory_count: 0, reason: null
      },
      evaluation_issue_reason: null
    }],
    ["seed materialization drop", {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: {
        status: "drop", emitted_memory_count: 0, reason: "materialization_drop"
      },
      evaluation_issue_reason: "extraction_materialization_drop"
    }]
  ])("fails closed for current rows with %s", (_label, cohort) => {
    expect(classifyQuestionMeasurementStatus(diagnostic(cohort)))
      .toBe("evaluator_identity_unscorable");
  });

  it("classifies a ledger abstention before evaluator identity fallback", () => {
    expect(classifyQuestionMeasurementStatus(abstentionDiagnostic({
      dataset_cohort: "abstention",
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      extraction_materialization: {
        status: "unknown", emitted_memory_count: 0, reason: null
      },
      evaluation_issue_reason: null
    }))).toBe("abstention_unscorable");
  });
});

const MEASUREMENT_STATUSES = [
  "scorable",
  "abstention_unscorable",
  "evaluator_identity_unscorable"
] as const;

type StatusInput = {
  readonly isAbstention: boolean;
  readonly cohortLedger: QuestionMeasurementPrimitiveLedger;
};

const MEASUREMENT_STATUS_CASES: readonly {
  readonly name: string;
  readonly input: StatusInput;
  readonly expected: QuestionMeasurementStatus;
}[] = [
  statusCase("valid answerable", false, validAnswerableLedger(), "scorable"),
  statusCase("cohort overrides stale abstention flag", true,
    validAnswerableLedger(), "scorable"),
  statusCase("absent evaluator identity", false, {
    ...validAnswerableLedger(),
    evaluator_gold_identity: { status: "absent", object_ids: [] },
    extraction_materialization: { status: "unknown", emitted_memory_count: 0, reason: null }
  }, "evaluator_identity_unscorable"),
  statusCase("empty evaluator object IDs", false, {
    ...validAnswerableLedger(),
    evaluator_gold_identity: { status: "present", object_ids: [] },
    extraction_materialization: { status: "unknown", emitted_memory_count: 0, reason: null }
  }, "evaluator_identity_unscorable"),
  statusCase("ambiguous evaluator identity", false, {
    ...validAnswerableLedger(), evaluator_gold_identity: { status: "ambiguous", object_ids: ["gold"] }
  }, "evaluator_identity_unscorable"),
  statusCase("materialization drop", false, {
    ...validAnswerableLedger(), extraction_materialization: {
      status: "drop", emitted_memory_count: 0, reason: "materialization_drop"
    }
  }, "evaluator_identity_unscorable"),
  statusCase("explicit evaluator issue", false, {
    ...validAnswerableLedger(), evaluation_issue_reason: "identity_join_error"
  }, "evaluator_identity_unscorable"),
  statusCase("dataset abstention", false, {
    ...validAnswerableLedger(), dataset_cohort: "abstention"
  }, "abstention_unscorable"),
  statusCase("adjudicated invalid", false, {
    ...validAnswerableLedger(), dataset_cohort: "adjudicated_invalid"
  }, "evaluator_identity_unscorable")
];

function statusCase(
  name: string,
  isAbstention: boolean,
  cohortLedger: QuestionMeasurementPrimitiveLedger,
  expected: QuestionMeasurementStatus
) {
  return { name, input: { isAbstention, cohortLedger }, expected };
}

function validAnswerableLedger(): QuestionMeasurementPrimitiveLedger {
  return {
    dataset_cohort: "answerable",
    evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
    extraction_materialization: {
      status: "memory_emitted", emitted_memory_count: 1, reason: null
    },
    evaluation_issue_reason: null
  };
}

function withPersistedStatus(
  input: StatusInput,
  measurement_status: QuestionMeasurementStatus
): StatusInput {
  return {
    ...input,
    cohortLedger: { ...input.cohortLedger, measurement_status }
  };
}
