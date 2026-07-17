import type { PerScenarioRow } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestionDiagnostic } from "../../../longmemeval/diagnostics.js";
import { assertMeasurementCohortBinding } from "../../../longmemeval/measurement/cohort-binding.js";

describe("measurement cohort binding", () => {
  it.each([
    ["plain-id", "abstention", false, "dataset_declared_abstention"],
    ["looks_abs", "answerable", true, "answerable"]
  ] as const)("binds %s to dataset evidence, not its name", (
    id,
    datasetCohort,
    scorable,
    measurementCohort
  ) => {
    expect(() => assertMeasurementCohortBinding(
      [row(id, scorable, measurementCohort)],
      [diagnostic(id, datasetCohort)]
    )).not.toThrow();
  });

  it("rejects relabeling an answerable row as abstention", () => {
    expect(() => assertMeasurementCohortBinding(
      [row("question-1", false, "dataset_declared_abstention")],
      [diagnostic("question-1", "answerable")]
    )).toThrow(/cohort mismatch/u);
  });

  it("binds adjudicated invalid evidence as unscorable answerable", () => {
    expect(() => assertMeasurementCohortBinding(
      [row("dataset-issue", false, "answerable")],
      [diagnostic("dataset-issue", "adjudicated_invalid")]
    )).not.toThrow();
  });

  it("rejects rows without one-to-one diagnostic evidence", () => {
    expect(() => assertMeasurementCohortBinding(
      [row("question-1", true, "answerable")],
      [diagnostic("different-question", "answerable")]
    )).toThrow(/diagnostic evidence/u);
  });

  it("rejects a persisted status that contradicts primitive measurement axes", () => {
    const current = diagnostic("question-1", "answerable");
    const forged = {
      ...current,
      cohort_ledger: {
        ...current.cohort_ledger!,
        measurement_status: "evaluator_identity_unscorable" as const
      }
    } as LongMemEvalQuestionDiagnostic;

    expect(() => assertMeasurementCohortBinding(
      [row("question-1", true, "answerable")],
      [forged]
    )).toThrow(/persisted measurement status/u);
  });
});

function row(
  id: string,
  scorable: boolean,
  measurementCohort: NonNullable<PerScenarioRow["measurement_cohort"]>
): PerScenarioRow {
  return {
    id,
    version: 1,
    hit_at_5: scorable,
    scorable,
    measurement_cohort: measurementCohort,
    tier: "hot"
  };
}

function diagnostic(
  questionId: string,
  datasetCohort: "answerable" | "abstention" | "adjudicated_invalid"
): LongMemEvalQuestionDiagnostic {
  return {
    question_id: questionId,
    is_abstention: datasetCohort === "abstention",
    cohort_ledger: {
      dataset_cohort: datasetCohort,
      measurement_status: datasetCohort === "adjudicated_invalid"
        ? "evaluator_identity_unscorable"
        : datasetCohort === "abstention" ? "abstention_unscorable" : "scorable",
      evaluator_gold_identity: datasetCohort === "answerable"
        ? { status: "present", object_ids: ["gold"] }
        : { status: "absent", object_ids: [] },
      extraction_materialization: datasetCohort === "answerable"
        ? { status: "memory_emitted", emitted_memory_count: 1, reason: null }
        : { status: "unknown", emitted_memory_count: 0, reason: null },
      evaluation_issue_reason: null
    }
  } as unknown as LongMemEvalQuestionDiagnostic;
}
