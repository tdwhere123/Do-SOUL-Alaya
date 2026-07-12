import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import { classifyQuestionMeasurementStatus } from "../../longmemeval/measurement/question-validity.js";
// @ts-expect-error The executable MJS replay contract is intentionally outside package declarations.
import { isScorableMeasurementCohort, measurementUnscorableReason } from "../../../scripts/longmemeval-replay/measurement-status.mjs";

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
  it.each([
    ["answerable ledger over stale abstention flag", true, {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: { status: "memory_emitted" },
      evaluation_issue_reason: null
    }, "scorable", null],
    ["abstention ledger over stale answerable flag", false, {
      dataset_cohort: "abstention",
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      extraction_materialization: { status: "unknown" },
      evaluation_issue_reason: null
    }, "abstention_unscorable", "abstention_unscorable"],
    ["answerable no-gold row", false, {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: [] },
      extraction_materialization: { status: "memory_emitted" },
      evaluation_issue_reason: null
    }, "evaluator_identity_unscorable", "evaluator_identity_unscorable"],
    ["persisted status", false, {
      measurement_status: "evaluator_identity_unscorable",
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: { status: "memory_emitted" },
      evaluation_issue_reason: null
    }, "evaluator_identity_unscorable", "evaluator_identity_unscorable"]
  ] as const)("keeps TS and MJS legacy validity aligned for %s", (
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

  it.each([
    ["no gold object IDs", {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: [] },
      extraction_materialization: { status: "memory_emitted" },
      evaluation_issue_reason: null
    }],
    ["seed materialization drop", {
      dataset_cohort: "answerable",
      evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
      extraction_materialization: { status: "drop" },
      evaluation_issue_reason: "extraction_materialization_drop"
    }]
  ])("fails closed for legacy rows with %s", (_label, cohort) => {
    expect(classifyQuestionMeasurementStatus(diagnostic(cohort)))
      .toBe("evaluator_identity_unscorable");
  });

  it("classifies a legacy abstention before evaluator identity fallback", () => {
    expect(classifyQuestionMeasurementStatus(abstentionDiagnostic({
      dataset_cohort: "abstention",
      evaluator_gold_identity: { status: "absent", object_ids: [] },
      extraction_materialization: { status: "unknown" },
      evaluation_issue_reason: null
    }))).toBe("abstention_unscorable");
  });
});
