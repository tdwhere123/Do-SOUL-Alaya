import { describe, expect, it } from "vitest";
import { measurementContractAllowsEligibility } from "../../schema/kpi-measurement-contract.js";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import {
  buildFullLongMemEvalPayload,
  selectionContractForRows
} from "../history/history-fixture.js";

describe("answerable-recall measurement attribution v3", () => {
  it.each([
    [100, 94, 6],
    [500, 470, 30]
  ])("accepts exact scoped accounting: %i=%i+%i", (evaluated, answerable, abstention) => {
    const parsed = KpiPayloadSchema.parse(
      answerableRecallPayload(evaluated, answerable, abstention)
    );

    expect(measurementContractAllowsEligibility(parsed)).toBe(true);
    expect(parsed.measurement_attribution).toMatchObject({
      schema_version: "bench-measurement-attribution.v3",
      measurement_scope: "answerable_recall",
      abstention_evaluation_status: "excluded_not_evaluated",
      abstention_calibration_status: "uncalibrated",
      abstention_gate_eligible: false,
      gate_eligible: true
    });
  });

  it("rejects a cohort label that contradicts its scorable state", () => {
    const payload = answerableRecallPayload(100, 94, 6);
    const rows = payload.kpi.per_scenario.map((row, index) => index === 0
      ? { ...row, measurement_cohort: "dataset_declared_abstention" }
      : row);

    expect(() => KpiPayloadSchema.parse({
      ...payload, kpi: { ...payload.kpi, per_scenario: rows }
    })).toThrow(/measurement cohort/u);
  });

  it("requires every v3 row to declare its cohort", () => {
    const payload = answerableRecallPayload(100, 94, 6);
    const rows = payload.kpi.per_scenario.map((row, index) => index === 0
      ? { ...row, measurement_cohort: undefined }
      : row);

    expect(() => KpiPayloadSchema.parse({
      ...payload, kpi: { ...payload.kpi, per_scenario: rows }
    })).toThrow(/v3.*cohort|cohort.*v3/u);
  });

  it("rejects scoped eligibility when evaluator gold identity is incomplete", () => {
    const payload = answerableRecallPayload(100, 94, 6);

    expect(() => KpiPayloadSchema.parse({
      ...payload,
      kpi: {
        ...payload.kpi,
        quality_metrics: { ...payload.kpi.quality_metrics, no_gold_count: 1 }
      }
    })).toThrow(/evaluator identity/u);
  });

  it("reads v2 attribution but never promotes it", () => {
    const current = answerableRecallPayload(100, 94, 6);
    const legacy = KpiPayloadSchema.parse({
      ...current,
      measurement_attribution: {
        schema_version: "bench-measurement-attribution.v2",
        status: "ineligible",
        gate_eligible: false,
        evidence_status: "complete",
        candidate_pool_complete: true,
        provenance_complete: true,
        abstention_calibration_status: "uncalibrated",
        evaluator_identity_status: "complete"
      }
    });

    expect(measurementContractAllowsEligibility(legacy)).toBe(false);
  });
});

function answerableRecallPayload(evaluated: number, answerable: number, abstention: number) {
  const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
  const rows = Array.from({ length: evaluated }, (_, index) => ({
    id: index < answerable ? `question-${index + 1}` : `question-${index + 1}_abs`,
    version: 1,
    hit_at_5: index < answerable,
    scorable: index < answerable,
    measurement_cohort: index < answerable
      ? "answerable" as const
      : "dataset_declared_abstention" as const,
    tier: "hot" as const
  }));
  return {
    ...base,
    dataset: { ...base.dataset, size: evaluated },
    sample_size: evaluated,
    evaluated_count: evaluated,
    answerable_evaluated_count: answerable,
    selection_contract: selectionContractForRows(rows),
    measurement_attribution: {
      schema_version: "bench-measurement-attribution.v3",
      status: "eligible",
      gate_eligible: true,
      evidence_status: "complete",
      candidate_pool_complete: true,
      provenance_complete: true,
      measurement_scope: "answerable_recall",
      abstention_evaluation_status: "excluded_not_evaluated",
      abstention_calibration_status: "uncalibrated",
      abstention_gate_eligible: false,
      abstention_evidence_status: "current_uncalibrated",
      evaluator_identity_status: "complete"
    },
    kpi: {
      ...base.kpi,
      r_at_5: 1,
      per_scenario: rows,
      quality_metrics: {
        ...base.kpi.quality_metrics!,
        no_gold_count: 0,
        evaluator_identity_issue_count: 0,
        evaluator_identity_unscorable_count: 0,
        measurement_cohort_counts: {
          evaluated,
          non_abstention: answerable,
          abstention,
          scorable_answerable: answerable,
          unscorable_answerable: 0,
          hit_at_5: answerable,
          miss_at_5: 0
        },
        unscorable_reason_distribution: abstention === 0
          ? {}
          : { abstention_uncalibrated: abstention },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: abstention,
          scored: 0,
          unscorable: abstention,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      }
    }
  };
}
