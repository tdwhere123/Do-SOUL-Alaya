import { describe, expect, it } from "vitest";
import { buildStageAttributionTables } from
  "../../../../../diagnostics/stage-attribution/build-tables.js";
import { compareF0F2VsCachedF3 } from
  "../../../../../diagnostics/stage-attribution/diagnostic-100q.js";
import { buildTreatmentExposureReceipts } from
  "../../../../../diagnostics/stage-attribution/exposure/build-receipts.js";
import { evaluateCanaryPolarityMatrix } from
  "../../../../../diagnostics/stage-attribution/exposure/canary-polarity-matrix.js";
import {
  CANARY_Q1,
  CANARY_Q2,
  CANARY_Q3
} from "../../../../../diagnostics/stage-attribution/exposure/canary-ids.js";
import {
  controlCanaryDiagnostics,
  passingTreatmentCanaryDiagnostics
} from "../../../diagnostic-loop/canary-arm-diagnostics.js";
import {
  assembledQuestion,
  cohortOnlyQuestion,
  flagOnlyQuestion
} from "../../abstention-diagnostic-fixture.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../../../diagnostics/schema/diagnostics-types.js";

const CANARY_IDS = [CANARY_Q1, CANARY_Q2, CANARY_Q3];
const ABS_TWIN_ID = "0862e8bf_abs";
const ORDINARY_ID = "58bf7951";

describe("production stage/receipt pairing with abstention twins", () => {
  it("pairs live-shaped canaries plus 0862e8bf_abs through tables, receipts, and compare", () => {
    const absTwin = assembledQuestion({
      questionId: ABS_TWIN_ID, isAbstention: true
    });
    const baseline = pair(controlCanaryDiagnostics(), passingTreatmentCanaryDiagnostics());
    const mixed = pair(
      [...controlCanaryDiagnostics(), absTwin],
      [...passingTreatmentCanaryDiagnostics(), absTwin]
    );

    expect(mixed.controlTable.questions.map((row) => row.question_id))
      .toEqual(CANARY_IDS);
    expect(mixed.treatmentTable.questions.map((row) => row.question_id))
      .toEqual(CANARY_IDS);
    expect(mixed.receipts.map((receipt) => receipt.question_id)).toEqual(
      [...CANARY_IDS].sort()
    );
    expect(evaluateCanaryPolarityMatrix(mixed.receipts))
      .toEqual(evaluateCanaryPolarityMatrix(baseline.receipts));
    expect(mixed.comparison.canary_polarity_matrix.passed).toBe(true);
    expect(mixed.comparison.canary_polarity_matrix)
      .toEqual(baseline.comparison.canary_polarity_matrix);
    expect(mixed.comparison.exposure_sli).toMatchObject({
      denominator_kind: "formed_osf_answerable",
      denominator_count: 1,
      exposed_count: 1,
      excluded: {
        named_negative_control_count: 2,
        leaked_negative_control_exposed_count: 0
      }
    });
    expect(mixed.comparison.exposure_sli).toEqual(baseline.comparison.exposure_sli);
  });

  it("still fail-closes when an ordinary diagnostic has no stage row", () => {
    const extra = assembledQuestion({ questionId: ORDINARY_ID });
    const paired = pair(
      [...controlCanaryDiagnostics(), assembledQuestion({
        questionId: ABS_TWIN_ID, isAbstention: true
      })],
      [...passingTreatmentCanaryDiagnostics(), assembledQuestion({
        questionId: ABS_TWIN_ID, isAbstention: true
      })]
    );
    expect(() => buildTreatmentExposureReceipts({
      control: [...paired.control, extra],
      treatment: [...paired.treatment, extra],
      controlStages: paired.controlTable.questions,
      treatmentStages: paired.treatmentTable.questions
    })).toThrow(/missing control stage row for 58bf7951/u);
  });
});

describe("exposure abstention disjuncts", () => {
  it("skips flag-only and cohort-only rows that lack an _abs suffix", () => {
    const flagOnly = flagOnlyQuestion(ORDINARY_ID);
    const cohortOnly = cohortOnlyQuestion("7c1d9e20");
    expect(flagOnly.question_id.endsWith("_abs")).toBe(false);
    expect(cohortOnly.question_id.endsWith("_abs")).toBe(false);

    const flagPair = pair(
      [...controlCanaryDiagnostics(), flagOnly],
      [...passingTreatmentCanaryDiagnostics(), flagOnly]
    );
    const cohortPair = pair(
      [...controlCanaryDiagnostics(), cohortOnly],
      [...passingTreatmentCanaryDiagnostics(), cohortOnly]
    );

    expect(flagPair.receipts.map((receipt) => receipt.question_id))
      .toEqual([...CANARY_IDS].sort());
    expect(cohortPair.receipts.map((receipt) => receipt.question_id))
      .toEqual([...CANARY_IDS].sort());
    expect(flagPair.comparison.canary_polarity_matrix.passed).toBe(true);
    expect(cohortPair.comparison.canary_polarity_matrix.passed).toBe(true);
  });

  it("does not skip an ordinary empty-gold id from receipts", () => {
    const ordinary = assembledQuestion({ questionId: ORDINARY_ID });
    const paired = pair(
      [...controlCanaryDiagnostics(), ordinary],
      [...passingTreatmentCanaryDiagnostics(), ordinary]
    );
    expect(paired.receipts.map((receipt) => receipt.question_id))
      .toEqual([CANARY_Q2, CANARY_Q3, ORDINARY_ID, CANARY_Q1]);
  });

  it("fail-closes when the same id is abstention on only one arm", () => {
    const flagged = flagOnlyQuestion(ORDINARY_ID);
    const ordinary = assembledQuestion({ questionId: ORDINARY_ID });
    const controlFlagged = pairTables(
      [...controlCanaryDiagnostics(), flagged],
      [...passingTreatmentCanaryDiagnostics(), ordinary]
    );
    expect(() => buildTreatmentExposureReceipts(controlFlagged))
      .toThrow(/inconsistent abstention pairing for 58bf7951/u);

    const treatmentFlagged = pairTables(
      [...controlCanaryDiagnostics(), ordinary],
      [...passingTreatmentCanaryDiagnostics(), flagged]
    );
    expect(() => buildTreatmentExposureReceipts(treatmentFlagged))
      .toThrow(/inconsistent abstention pairing for 58bf7951/u);

    const controlCohort = pairTables(
      [...controlCanaryDiagnostics(), cohortOnlyQuestion(ORDINARY_ID)],
      [...passingTreatmentCanaryDiagnostics(), ordinary]
    );
    expect(() => buildTreatmentExposureReceipts(controlCohort))
      .toThrow(/inconsistent abstention pairing for 58bf7951/u);
  });
});

function pair(
  control: readonly LongMemEvalQuestionDiagnostic[],
  treatment: readonly LongMemEvalQuestionDiagnostic[]
) {
  const tables = pairTables(control, treatment);
  const receipts = buildTreatmentExposureReceipts(tables);
  return {
    ...tables,
    receipts,
    comparison: compareF0F2VsCachedF3({
      control: tables.controlTable.questions,
      treatment: tables.treatmentTable.questions,
      treatmentExposure: receipts
    })
  };
}

function pairTables(
  control: readonly LongMemEvalQuestionDiagnostic[],
  treatment: readonly LongMemEvalQuestionDiagnostic[]
) {
  const controlTable = buildStageAttributionTables({
    cell: "A", sourceDiagnostics: "fixture", questions: control
  });
  const treatmentTable = buildStageAttributionTables({
    cell: "B", sourceDiagnostics: "fixture", questions: treatment
  });
  return {
    control,
    treatment,
    controlTable,
    treatmentTable,
    controlStages: controlTable.questions,
    treatmentStages: treatmentTable.questions
  };
}
