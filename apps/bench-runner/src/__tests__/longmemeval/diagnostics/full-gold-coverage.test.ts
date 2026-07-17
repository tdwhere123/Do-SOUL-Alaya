import { describe, expect, it } from "vitest";

import { buildLongMemEvalFullGoldCoverage } from "../../../longmemeval/diagnostics.js";
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

  it("reports delivery_contribution from fusion-stage vs delivered ranks", () => {
    const lift = buildQuestion("q-lift", [
      buildGold({
        object_id: "g1",
        final_rank: 4,
        rank_after_fusion: 8
      }),
      buildGold({ object_id: "g2", final_rank: 2, rank_after_fusion: 2 })
    ]);
    const drop = buildQuestion("q-drop", [
      buildGold({
        object_id: "g3",
        final_rank: 8,
        rank_after_fusion: 2
      }),
      buildGold({ object_id: "g4", final_rank: 1, rank_after_fusion: 1 })
    ]);
    const coverage = buildLongMemEvalFullGoldCoverage([lift, drop]);
    expect(coverage.delivery_contribution).toEqual({
      gold_bearing_questions: 2,
      full_gold_at_5: 0.5,
      core_full_gold_at_5: 0.5,
      delivery_lift_questions: 1,
      delivery_drop_questions: 1,
      gold_coverage_at_5: 0.75,
      core_gold_coverage_at_5: 0.75,
      delivery_lift_golds: 1,
      delivery_drop_golds: 1
    });
  });

  it("does not treat pre_budget_rank alone as core delivery rank", () => {
    const budgetOnly = buildQuestion("q-budget-core", [
      buildGold({
        object_id: "g1",
        final_rank: null,
        pre_budget_rank: 4,
        fused_rank: null,
        rank_after_fusion: null,
        budget_drop_reason: "max_entries"
      })
    ]);
    const coverage = buildLongMemEvalFullGoldCoverage([budgetOnly]);
    expect(coverage.delivery_contribution?.core_gold_coverage_at_5).toBe(0);
    expect(coverage.delivery_contribution?.delivery_lift_golds).toBe(0);
    expect(coverage.delivery_contribution?.delivery_drop_golds).toBe(0);
  });

  it("returns zeros (no divide-by-zero) on an empty diagnostics set", () => {
    const coverage = buildLongMemEvalFullGoldCoverage([]);
    expect(coverage.gold_bearing_questions).toBe(0);
    expect(coverage.full_gold_at_5).toBe(0);
    expect(coverage.pool_recall_at_100).toBe(0);
  });
});
