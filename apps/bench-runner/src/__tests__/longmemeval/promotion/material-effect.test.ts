import { describe, expect, it } from "vitest";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import { verifyLongMemEvalMaterialEffect } from "../../../datasets/longmemeval/promotion/schema/material-effect.js";
import { withAnswerRerank } from "../recall-eval/archive-fixture.js";
import { makeEligibleMeasurementAttribution, makeQualityMetrics, makeShardKpi } from "../../cli/merge/cli-merge-validations-fixture.js";

describe("material effect token evidence", () => {
  it.each(["control", "product"] as const)("refuses otherwise valid effect with unavailable %s token evidence", (side) => {
    const input = { control: measuredPayload(40), product: measuredPayload(60) };
    expect(verifyLongMemEvalMaterialEffect(input)).toMatchObject({ status: "passed",
      paired_r_at_5: { answerable_count: 94, control_hits: 40, product_hits: 60, gained: 20, lost: 0 },
      safeguards: { token_saved_ratio_vs_full_prompt: { control: 0.9, product: 0.9, delta: 0 } } });
    const unavailable = { ...input, [side]: KpiPayloadSchema.parse({ ...input[side],
      kpi: { ...input[side].kpi, token_saved_ratio_vs_full_prompt: null } }) };
    expect(() => verifyLongMemEvalMaterialEffect(unavailable))
      .toThrow(/material effect requires available measurements/u);
  });
});

function measuredPayload(hits: number): KpiPayload {
  const rate = hits / 94;
  const base = makeShardKpi();
  const payload = makeShardKpi({ evaluated_count: 100, answerable_evaluated_count: 94,
    measurement_attribution: makeEligibleMeasurementAttribution(),
    kpi: { ...base.kpi, r_at_1: rate, r_at_5: rate, r_at_10: rate,
      token_saved_ratio_vs_full_prompt: 0.9,
      full_gold_coverage: { gold_bearing_questions: 94, full_gold_at_5: rate, full_gold_at_10: rate,
        gold_coverage_at_5: rate, gold_coverage_at_10: rate, pool_recall_at_50: 1, pool_recall_at_100: 1 },
      quality_metrics: { ...makeQualityMetrics({ denominator: 94, candidateAbsent: 94 - hits }),
        abstention: { schema_version: "bench-abstention.v2", total: 6, scored: 0, unscorable: 6,
          method: "fused_margin_diagnostic_only", calibration_status: "uncalibrated", gate_eligible: false },
        measurement_cohort_counts: { evaluated: 100, non_abstention: 94, abstention: 6,
          scorable_answerable: 94, unscorable_answerable: 0, hit_at_5: hits, miss_at_5: 94 - hits },
        unscorable_reason_distribution: { abstention_uncalibrated: 6 }
      },
      per_scenario: Array.from({ length: 100 }, (_, index) => ({ id: `question-${index}`, version: 1,
        hit_at_1: index < hits, hit_at_5: index < hits, hit_at_10: index < hits,
        scorable: index < 94, measurement_cohort: index < 94 ? "answerable" : "dataset_declared_abstention",
        tier: "warm" }))
    }
  });
  return KpiPayloadSchema.parse(withAnswerRerank(payload, { enabled: false }));
}
