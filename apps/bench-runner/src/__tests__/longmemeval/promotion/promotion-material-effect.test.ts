import { describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  exactTwoSidedMcNemarPValue,
  verifyLongMemEvalMaterialEffect
} from "../../../longmemeval/promotion/schema/material-effect.js";

describe("LongMemEval material-effect authorization", () => {
  it.each([
    [9, 0, 0.00390625],
    [6, 0, 0.03125],
    [5, 0, 0.0625],
    [0, 0, 1],
    [10, 1, 0.01171875],
    [1, 10, 0.01171875]
  ])("computes exact two-sided McNemar for %i gains and %i losses", (
    gained,
    lost,
    expected
  ) => {
    expect(exactTwoSidedMcNemarPValue(gained, lost)).toBe(expected);
  });

  it("authorizes directional improvement and paired significance over exact 94/6 cohorts", () => {
    const effect = verifyLongMemEvalMaterialEffect({
      control: payload({ hits: 80, rAt1: 0.8, rAt10: 0.9, fullGoldAt5: 0.7 }),
      product: payload({ hits: 89, rAt1: 0.81, rAt10: 0.91, fullGoldAt5: 0.71 })
    });

    expect(effect.status).toBe("passed");
    expect(effect.paired_r_at_5).toMatchObject({
      answerable_count: 94,
      control_hits: 80,
      product_hits: 89,
      gained: 9,
      lost: 0,
      net: 9,
      mcnemar: { method: "exact_two_sided", p_value: 0.00390625 }
    });
  });

  it.each([
    ["R@1", { product: { rAt1: 0.79 } }],
    ["R@5", { product: { hits: 79 } }],
    ["R@10", { product: { rAt10: 0.89 } }],
    ["full-gold@5", { product: { fullGoldAt5: 0.69 } }],
    ["token economy", { product: { rAt1: 0.81, tokenSaved: 0.89 } }]
  ])("rejects a %s regression", (_label, override) => {
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: payload(override.product)
    })).toThrow(/regress/u);
  });

  it("rejects no directional gain, an insignificant five-win result, and cohort drift", () => {
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: payload()
    })).toThrow(/positive/u);
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload({ hits: 80 }),
      product: payload({ hits: 85 })
    })).toThrow(/McNemar/u);
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: payload({ answerableCount: 93 })
    })).toThrow(/94 answerable.*6 declared abstention/u);
  });

  it("rejects duplicate or mismatched paired rows and missing full-gold evidence", () => {
    const duplicate = payload();
    duplicate.kpi.per_scenario[1] = { ...duplicate.kpi.per_scenario[0]! };
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: duplicate
    })).toThrow(/unique question IDs/u);

    const mismatched = payload();
    mismatched.kpi.per_scenario[0] = {
      ...mismatched.kpi.per_scenario[0]!,
      measurement_cohort: "dataset_declared_abstention",
      scorable: false
    };
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: mismatched
    })).toThrow(/paired measurement rows/u);

    const missing = payload();
    missing.kpi.full_gold_coverage = undefined;
    expect(() => verifyLongMemEvalMaterialEffect({
      control: payload(),
      product: missing
    })).toThrow(/full-gold/u);
  });
});

interface PayloadOptions {
  readonly hits?: number;
  readonly rAt1?: number;
  readonly rAt10?: number;
  readonly fullGoldAt5?: number;
  readonly tokenSaved?: number;
  readonly answerableCount?: number;
}

function payload(options: PayloadOptions = {}): KpiPayload {
  const answerableCount = options.answerableCount ?? 94;
  const hits = options.hits ?? 80;
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: `question-${index + 1}`,
    version: 1,
    hit_at_5: index < hits,
    scorable: index < answerableCount,
    measurement_cohort: index < answerableCount
      ? "answerable" as const
      : "dataset_declared_abstention" as const,
    tier: "hot" as const
  }));
  return {
    evaluated_count: 100,
    answerable_evaluated_count: answerableCount,
    measurement_attribution: {
      status: "eligible",
      gate_eligible: true
    },
    kpi: {
      r_at_1: options.rAt1 ?? 0.8,
      r_at_5: hits / answerableCount,
      r_at_10: options.rAt10 ?? 0.9,
      token_saved_ratio_vs_full_prompt: options.tokenSaved ?? 0.9,
      full_gold_coverage: {
        gold_bearing_questions: answerableCount,
        full_gold_at_5: options.fullGoldAt5 ?? 0.7
      },
      per_scenario: rows
    }
  } as KpiPayload;
}
