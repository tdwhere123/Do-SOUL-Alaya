import { describe, expect, it } from "vitest";

// @ts-expect-error The executable MJS probe is intentionally outside the package declaration surface.
import { applyMonotonicGuard, buildBoundaryPairs, fitFoldLexicalModel, PREREGISTERED_GUARDS, summarizeGuardDecision } from "../../../../scripts/longmemeval-replay/separability-boundary-objective.mjs";

function scored(rank: number, score: number) {
  return { candidate: { object_id: `candidate-${rank}`, fused_rank: rank }, score };
}

describe("rank-5 boundary objective", () => {
  it("fits lexical document frequency and length only from the training fold", () => {
    const model = fitFoldLexicalModel([
      { answer_features: { content: "shared train train" } },
      { answer_features: { content: "shared second" } }
    ]);

    expect(model).toMatchObject({ document_count: 2, average_length: 2.5 });
    expect(model.document_frequency).toEqual({ second: 1, shared: 2, train: 1 });
    expect(model.document_frequency).not.toHaveProperty("heldout-only");
  });

  it("trains one best gold against only the current rank-10 boundary", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      candidate: { object_id: `candidate-${index + 1}`, fused_rank: index + 1 },
      vector: [[0, index + 1]]
    }));
    const pairs = buildBoundaryPairs(rows, new Set(["candidate-8", "candidate-12"]));

    expect(pairs).toHaveLength(9);
    expect(pairs.slice(0, 5).every((row: { weight: number; margin: number }) =>
      row.weight === 2 && row.margin === 1
    )).toBe(true);
    expect(pairs.slice(5).every((row: { weight: number; margin: number }) =>
      row.weight === 1 && row.margin === 0.5
    )).toBe(true);
  });

  it("pre-registers four bounded guards including the no-promotion sentinel", () => {
    expect(PREREGISTERED_GUARDS).toEqual([
      { name: "top5_protected_floor", protected_top_k: 5, promotion_cap: 0, minimum_score_advantage: null },
      { name: "top4_single_promotion", protected_top_k: 4, promotion_cap: 1, minimum_score_advantage: 0 },
      { name: "top4_margin_single_promotion", protected_top_k: 4, promotion_cap: 1, minimum_score_advantage: 0.5 },
      { name: "top3_margin_two_promotions", protected_top_k: 3, promotion_cap: 2, minimum_score_advantage: 1 }
    ]);
  });

  it("never demotes protected candidates and caps admitted promotions", () => {
    const rows = [
      scored(1, -5), scored(2, -4), scored(3, -3), scored(4, -2), scored(5, 0),
      scored(6, 4), scored(7, 3), scored(8, 2)
    ];
    const result = applyMonotonicGuard(rows, PREREGISTERED_GUARDS[1]);

    expect(result.top_5_candidate_keys).toEqual([
      "candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-6"
    ]);
    expect(result.promoted_candidate_keys).toEqual(["candidate-6"]);
    expect(result.displaced_candidate_keys).toEqual(["candidate-5"]);
    expect(result.promotion_decisions).toEqual([{
      promoted_candidate_key: "candidate-6",
      displaced_candidate_key: "candidate-5",
      score_advantage: 4
    }]);
  });

  it("protects the current delivered top five instead of the pre-delivery fused top five", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      candidate: {
        object_id: `candidate-${index + 1}`,
        fused_rank: index + 1,
        final_rank: index === 0 ? 6 : index
      },
      score: 0
    }));

    expect(applyMonotonicGuard(rows, PREREGISTERED_GUARDS[0]).top_5_candidate_keys)
      .toEqual(["candidate-2", "candidate-3", "candidate-4", "candidate-5", "candidate-6"]);
  });

  it("admits only net-positive held-out guards as candidates", () => {
    const guards = [
      { name: "neutral", end_to_end_any_at_5_count: 78, gain_count: 0, loss_count: 0, net_gain_count: 0 },
      { name: "positive", end_to_end_any_at_5_count: 80, gain_count: 3, loss_count: 1, net_gain_count: 2 },
      { name: "inconsistent", end_to_end_any_at_5_count: 81, gain_count: 0, loss_count: 1, net_gain_count: -1 },
      { name: "negative", end_to_end_any_at_5_count: 77, gain_count: 1, loss_count: 2, net_gain_count: -1 }
    ];

    expect(summarizeGuardDecision(guards, 78, 94)).toEqual({
      acceptance_rule: "held_out_net_gain_strictly_positive",
      candidate_guard_names: ["positive"],
      zero_loss_candidate_guard_names: [],
      best_candidate_guard: "positive",
      theoretical_gate: { target_hits: 85, target_denominator: 94, reached: false },
      production_authorization: "offline_evidence_only"
    });
  });
});
