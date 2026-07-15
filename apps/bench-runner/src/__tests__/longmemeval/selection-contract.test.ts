import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import {
  assertSelectionCohortBinding,
  createLongMemEvalSelectionContract,
  selectionContractIdentity
} from "../../longmemeval/selection/contract.js";

const DATASET_SHA = "a".repeat(64);

describe("LongMemEval immutable selection contract", () => {
  it("derives all identities and expected cohorts from one selected question set", () => {
    const contract = createLongMemEvalSelectionContract({
      datasetSha256: DATASET_SHA,
      questions: [question("plain"), question("declared_abs")]
    });

    expect(selectionContractIdentity(contract)).toMatchObject({
      schema_version: 1,
      dataset_sha256: DATASET_SHA,
      selected_count: 2,
      expected_cohort_counts: { answerable: 1, abstention: 1 },
      selected_id_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      cohort_assignment_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("rejects an observed ledger whose cohort assignment differs", () => {
    const contract = createLongMemEvalSelectionContract({
      datasetSha256: DATASET_SHA,
      questions: [question("plain"), question("declared_abs")]
    });

    expect(() => assertSelectionCohortBinding(contract, [
      { question_id: "plain", dataset_cohort: "abstention" },
      { question_id: "declared_abs", dataset_cohort: "abstention" }
    ])).toThrow(/selection cohort binding/u);
  });
});

function question(id: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "fixture",
    question: id,
    answer: id,
    question_date: "2026-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: []
  };
}
