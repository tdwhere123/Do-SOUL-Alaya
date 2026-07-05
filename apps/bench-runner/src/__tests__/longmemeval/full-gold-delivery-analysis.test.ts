import { describe, expect, it } from "vitest";
import { analyzeFullGoldDeliveryContribution } from "../../longmemeval/full-gold-delivery-analysis.js";

describe("analyzeFullGoldDeliveryContribution", () => {
  it("reports delivery contribution separately from fusion-stage order", () => {
    const analysis = analyzeFullGoldDeliveryContribution([
      {
        questionId: "q-lift",
        gold: [
          { objectId: "g1", deliveredRank: 4, coreRank: 8 },
          { objectId: "g2", deliveredRank: 2, coreRank: 2 }
        ]
      },
      {
        questionId: "q-drop",
        gold: [
          { objectId: "g3", deliveredRank: 8, coreRank: 2 },
          { objectId: "g4", deliveredRank: 1, coreRank: 1 }
        ]
      },
      {
        questionId: "q-clean",
        gold: [
          { objectId: "g5", deliveredRank: 1, coreRank: 1 },
          { objectId: "g6", deliveredRank: 3, coreRank: 3 }
        ]
      }
    ]);

    expect(analysis.gold_bearing_questions).toBe(3);
    expect(analysis.core_full_gold_at_5).toBe(2 / 3);
    expect(analysis.full_gold_at_5).toBe(2 / 3);
    expect(analysis.delivery_lift_questions).toBe(1);
    expect(analysis.delivery_drop_questions).toBe(1);
    expect(analysis.delivery_lift_golds).toBe(1);
    expect(analysis.delivery_drop_golds).toBe(1);
    expect(analysis.core_gold_coverage_at_5).toBe(5 / 6);
    expect(analysis.gold_coverage_at_5).toBe(5 / 6);
  });

  it("returns zeros on an empty question set", () => {
    const analysis = analyzeFullGoldDeliveryContribution([]);
    expect(analysis.gold_bearing_questions).toBe(0);
    expect(analysis.full_gold_at_5).toBe(0);
    expect(analysis.core_full_gold_at_5).toBe(0);
    expect(analysis.delivery_lift_golds).toBe(0);
    expect(analysis.delivery_drop_golds).toBe(0);
  });
});
