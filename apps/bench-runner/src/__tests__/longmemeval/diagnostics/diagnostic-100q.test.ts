import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_500Q_CLOSED,
  compareF0F2VsCachedF3,
  mapQuestionToDiagnosticStage
} from "../../../longmemeval/diagnostics/stage-attribution/diagnostic-100q.js";
import type { QuestionStageRow } from "../../../longmemeval/diagnostics/stage-attribution/types.js";

describe("diagnostic 100Q stage map", () => {
  it("maps the earliest failed stage and keeps 500Q closed", () => {
    expect(DIAGNOSTIC_500Q_CLOSED).toBe(true);
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "empty_gold_or_write_loss", miss_taxonomy: "evaluation_or_gold_issue"
    }))).toBe("S0");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "extraction_materialization_drop"
    }))).toBe("S1");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "semantic_factor_formation_rejected"
    }))).toBe("S2");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "miss_taxonomy.candidate_absent_with_emitted_gold"
    }))).toBe("S3");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 5, proof: "miss_taxonomy.budget_drop"
    }))).toBe("S4");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 7, hit_at_5: true, proof: "hit_at_5"
    }))).toBe("S5");
  });

  it("compares F0-F2 control with cached-F3 treatment without provider calls", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [
        row({ question_id: "q-improved", stage: 2, proof: "candidate_absent" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ],
      treatment: [
        row({ question_id: "q-improved", stage: 7, hit_at_5: true, proof: "hit_at_5" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ]
    });
    expect(comparison.physical_calls).toBe(0);
    expect(comparison.five_hundred_q_closed).toBe(true);
    expect(comparison.membership_improved).toEqual(["q-improved"]);
    expect(comparison.still_missing).toEqual(["q-still"]);
    expect(comparison.control_misses.S3).toBe(1);
    expect(comparison.treatment_misses.S4).toBe(1);
  });
});

function row(overrides: Partial<QuestionStageRow> & {
  readonly stage: QuestionStageRow["stage"];
  readonly proof: string;
}): QuestionStageRow {
  return {
    question_id: overrides.question_id ?? "q1",
    stage: overrides.stage,
    mechanism: overrides.mechanism ?? null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: overrides.miss_taxonomy ?? null,
    best_pool_rank: null,
    hit_at_5: overrides.hit_at_5 ?? false,
    proof: overrides.proof
  };
}
