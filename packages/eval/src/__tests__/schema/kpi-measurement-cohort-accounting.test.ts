import { expect, it } from "vitest";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import {
  buildFullLongMemEvalPayload,
  selectionContractForRows
} from "../history/history-fixture.js";

it("accounts for evaluator-invalid answerable rows outside the recall denominator", () => {
  const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
  const rows = [
    {
      id: "q-valid", version: 1, hit_at_5: true, scorable: true,
      measurement_cohort: "answerable" as const, tier: "hot" as const
    },
    {
      id: "q-invalid", version: 1, hit_at_5: false, scorable: false,
      measurement_cohort: "answerable" as const, tier: "cold" as const
    }
  ];
  const payload = {
    ...base,
    evaluated_count: 2,
    answerable_evaluated_count: 1,
    selection_contract: selectionContractForRows(rows),
    measurement_attribution: {
      ...base.measurement_attribution,
      status: "ineligible",
      gate_eligible: false,
      evidence_status: "partial",
      candidate_pool_complete: false,
      evaluator_identity_status: "invalid"
    },
    kpi: {
      ...base.kpi,
      per_scenario: rows,
      quality_metrics: {
        ...base.kpi.quality_metrics,
        evaluator_identity_issue_count: 1,
        evaluator_identity_issue_denominator: 2,
        evaluator_identity_unscorable_count: 1,
        evaluator_identity_unscorable_denominator: 2,
        measurement_cohort_counts: {
          evaluated: 2, non_abstention: 2, abstention: 0,
          scorable_answerable: 1, unscorable_answerable: 1,
          hit_at_5: 1, miss_at_5: 0
        },
        unscorable_reason_distribution: { evaluator_identity_unscorable: 1 },
        miss_taxonomy_distribution: {
          candidate_absent: 0, materialization_drop: 0, budget_drop: 0,
          delivery_order_drop: 0, answer_set_coverage_drop: 0,
          evaluation_or_gold_issue: 0
        },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: 0,
          scored: 0,
          unscorable: 0,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      }
    }
  };

  expect(() => KpiPayloadSchema.parse(payload)).not.toThrow();
  const missingIdentityCount = {
    ...payload,
    kpi: {
      ...payload.kpi,
      quality_metrics: {
        ...payload.kpi.quality_metrics,
        evaluator_identity_unscorable_count: 0
      }
    }
  };
  expect(() => KpiPayloadSchema.parse(missingIdentityCount))
    .toThrow(/scorable=false.*evaluator identity/u);
});
