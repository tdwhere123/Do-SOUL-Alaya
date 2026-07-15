import { describe, expect, it } from "vitest";
import {
  computeLongMemEvalQuestionIdDigest,
  createLongMemEvalSelectionContractIdentity,
  findLongMemEvalSelectionBindingError,
  longMemEvalSelectionContractAllowsEligibility,
  type LongMemEvalSelectionAssignment
} from "../../schema/longmemeval-selection-contract.js";

const DATASET_SHA = "a".repeat(64);
const ASSIGNMENTS: readonly LongMemEvalSelectionAssignment[] = [
  { question_id: "q-answerable", dataset_cohort: "answerable" },
  { question_id: "q-abstention_abs", dataset_cohort: "abstention" }
];

describe("LongMemEval external selection contract", () => {
  it("binds verified dataset identity to ordered KPI observations", () => {
    const payload = currentPayload(ASSIGNMENTS);

    expect(longMemEvalSelectionContractAllowsEligibility(payload)).toBe(true);
  });

  it.each([
    ["missing contract", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload, selection_contract: undefined
    })],
    ["dataset SHA", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload,
      selection_contract: { ...payload.selection_contract, dataset_sha256: "b".repeat(64) }
    })],
    ["selected count", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload,
      selection_contract: { ...payload.selection_contract, selected_count: 1 }
    })],
    ["ordered IDs", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload,
      kpi: { ...payload.kpi, per_scenario: [...payload.kpi.per_scenario].reverse() }
    })],
    ["expected cohorts", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload,
      selection_contract: {
        ...payload.selection_contract,
        expected_cohort_counts: { answerable: 2, abstention: 0 }
      }
    })],
    ["ordered assignments", (payload: ReturnType<typeof currentPayload>) => ({
      ...payload,
      kpi: {
        ...payload.kpi,
        per_scenario: payload.kpi.per_scenario.map((row, index) => index === 0
          ? { ...row, measurement_cohort: "dataset_declared_abstention" as const }
          : row)
      }
    })]
  ])("rejects %s drift", (_label, forge) => {
    expect(longMemEvalSelectionContractAllowsEligibility(forge(currentPayload(ASSIGNMENTS))))
      .toBe(false);
  });

  it("rejects duplicate IDs at contract creation", () => {
    expect(() => createLongMemEvalSelectionContractIdentity({
      datasetSha256: DATASET_SHA,
      assignments: [ASSIGNMENTS[0]!, ASSIGNMENTS[0]!]
    })).toThrow(/unique/u);
  });

  it.each([
    ["empty", [""]],
    ["duplicate", ["q-1", "q-1"]]
  ])("rejects %s IDs at the shared digest seam", (_label, questionIds) => {
    expect(() => computeLongMemEvalQuestionIdDigest(questionIds)).toThrow(/question IDs/u);
  });

  it("returns a binding error for a typed-direct empty observed ID", () => {
    const payload = currentPayload(ASSIGNMENTS);
    const malformed = {
      ...payload,
      kpi: {
        per_scenario: payload.kpi.per_scenario.map((row, index) =>
          index === 0 ? { ...row, id: "" } : row)
      }
    };

    expect(() => findLongMemEvalSelectionBindingError(malformed)).not.toThrow();
    expect(findLongMemEvalSelectionBindingError(malformed)).toMatch(/non-empty/u);
  });
});

function currentPayload(assignments: readonly LongMemEvalSelectionAssignment[]) {
  return {
    dataset: { checksum_sha256: DATASET_SHA },
    evaluated_count: assignments.length,
    selection_contract: createLongMemEvalSelectionContractIdentity({
      datasetSha256: DATASET_SHA,
      assignments
    }),
    kpi: {
      per_scenario: assignments.map((assignment) => ({
        id: assignment.question_id,
        measurement_cohort: assignment.dataset_cohort === "abstention"
          ? "dataset_declared_abstention" as const
          : "answerable" as const
      }))
    }
  };
}
