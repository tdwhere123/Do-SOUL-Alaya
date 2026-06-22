import { describe, expect, it } from "vitest";

import { buildLongMemEvalFullGoldCoverage } from "../../longmemeval/diagnostics.js";
import {
  buildGoldDiagnostic as buildGold,
  buildQuestionDiagnosticFixture
} from "./gold-diagnostic-fixture.js";

const buildQuestion = (
  questionId: string,
  gold: ReadonlyArray<ReturnType<typeof buildGold>>
) => buildQuestionDiagnosticFixture({ questionId, gold });

describe("buildLongMemEvalFullGoldCoverage", () => {
  it("full_gold_at_5 requires EVERY gold top-5, unlike official any-gold r_at_5", () => {
    // 2-gold question: one delivered top-5, the other at rank 8 → official r_at_5
    // would credit this (any gold), but full_gold@5 must NOT.
    const question = buildQuestion("q-multi", [
      buildGold({ object_id: "g1", final_rank: 3 }),
      buildGold({ object_id: "g2", final_rank: 8 })
    ]);
    const coverage = buildLongMemEvalFullGoldCoverage([question]);
    expect(coverage.gold_bearing_questions).toBe(1);
    expect(coverage.full_gold_at_5).toBe(0);
    expect(coverage.full_gold_at_10).toBe(1);
    expect(coverage.gold_coverage_at_5).toBe(0.5);
    expect(coverage.gold_coverage_at_10).toBe(1);
  });

  it("counts a question only when all golds land top-5", () => {
    const question = buildQuestion("q-clean", [
      buildGold({ object_id: "g1", final_rank: 1 }),
      buildGold({ object_id: "g2", final_rank: 4 })
    ]);
    const coverage = buildLongMemEvalFullGoldCoverage([question]);
    expect(coverage.full_gold_at_5).toBe(1);
    expect(coverage.gold_coverage_at_5).toBe(1);
  });

  it("pool_recall uses pre_budget_rank (falling back to fused_rank), not delivered rank", () => {
    // g1: dropped by budget (final_rank null) but in pool at pre_budget_rank 40.
    // g2: no pre_budget_rank, fused_rank 90.
    const question = buildQuestion("q-pool", [
      buildGold({ object_id: "g1", final_rank: null, pre_budget_rank: 40, fused_rank: 40 }),
      buildGold({ object_id: "g2", final_rank: null, pre_budget_rank: null, fused_rank: 90 })
    ]);
    const coverage = buildLongMemEvalFullGoldCoverage([question]);
    expect(coverage.full_gold_at_5).toBe(0);
    expect(coverage.gold_coverage_at_5).toBe(0);
    expect(coverage.pool_recall_at_50).toBe(0.5);
    expect(coverage.pool_recall_at_100).toBe(1);
  });

  it("excludes abstention (_abs) and no-gold questions from the denominator", () => {
    const abstain = buildQuestion("q-1_abs", [buildGold({ object_id: "g1", final_rank: 1 })]);
    const noGold = buildQuestion("q-empty", []);
    const real = buildQuestion("q-real", [buildGold({ object_id: "g2", final_rank: 2 })]);
    const coverage = buildLongMemEvalFullGoldCoverage([abstain, noGold, real]);
    expect(coverage.gold_bearing_questions).toBe(1);
    expect(coverage.full_gold_at_5).toBe(1);
  });

  it("returns zeros (no divide-by-zero) on an empty diagnostics set", () => {
    const coverage = buildLongMemEvalFullGoldCoverage([]);
    expect(coverage.gold_bearing_questions).toBe(0);
    expect(coverage.full_gold_at_5).toBe(0);
    expect(coverage.pool_recall_at_100).toBe(0);
  });
});
