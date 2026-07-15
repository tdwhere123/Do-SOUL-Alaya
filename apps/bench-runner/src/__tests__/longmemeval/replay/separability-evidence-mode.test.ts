import { describe, expect, it } from "vitest";

import { resolveSeparabilityEvidenceMode } from
  "../../../../scripts/longmemeval-replay/separability-evidence-mode.mjs";

describe("separability evidence mode", () => {
  it("fails closed when current diagnostics cover only part of the cohort", () => {
    const rows = Array.from({ length: 7 }, (_, index) => cohortRow(
      `q-${index}`,
      index < 6
    ));
    const diagnostics = { questions: rows.slice(0, 6).map(diagnostic) };

    expect(() => resolveSeparabilityEvidenceMode(diagnostics, { cohort: { rows } }))
      .toThrow(/diagnostics must cover every current cohort row/u);
  });

  it("accepts complete current coverage and the explicit cohort-less legacy mode", () => {
    const rows = Array.from({ length: 7 }, (_, index) => cohortRow(`q-${index}`, true));
    const diagnostics = { questions: rows.map(diagnostic) };

    expect(resolveSeparabilityEvidenceMode(diagnostics, { cohort: { rows } }).size).toBe(7);
    expect(resolveSeparabilityEvidenceMode(diagnostics, { legacyDiagnostic: true })).toBeNull();
  });

  it("rejects a marked legacy row from the current cohort path", () => {
    const row = {
      ...cohortRow("q-legacy", false),
      measurement_evidence_mode: "legacy_synthesized"
    };

    expect(() => resolveSeparabilityEvidenceMode(
      { questions: [diagnostic(row)] },
      { cohort: { rows: [row] } }
    )).toThrow(/legacy synthesized measurement evidence/u);
  });
});

function cohortRow(questionId: string, complete: boolean) {
  return {
    question_id: questionId,
    measurement_status: "scorable",
    dataset_cohort: "answerable",
    extraction_materialization: {
      status: "memory_emitted",
      emitted_memory_count: 1,
      reason: null
    },
    evaluator_gold_identity: { status: "present", object_ids: [`gold-${questionId}`] },
    evaluation_issue_reason: null,
    evidence_status: complete ? "complete" : "partial",
    candidate_pool_complete: complete
  };
}

function diagnostic(row: ReturnType<typeof cohortRow>) {
  const { question_id, ...cohortLedger } = row;
  return {
    question_id,
    candidate_pool_complete: row.candidate_pool_complete,
    cohort_ledger: cohortLedger,
    candidates: []
  };
}
