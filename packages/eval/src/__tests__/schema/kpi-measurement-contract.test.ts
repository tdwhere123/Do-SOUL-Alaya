import { describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import { buildFullLongMemEvalPayload } from "../history/history-fixture.js";

describe("KPI measurement denominator contract", () => {
  it("binds r_at_5 to scorable per-scenario hit rows", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const forged = {
      ...base,
      kpi: {
        ...base.kpi,
        r_at_5: base.kpi.r_at_5 === 0 ? 1 : 0
      }
    };

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/r_at_5.*scorable.*hit_at_5/u);
  });

  it("defines zero answerable rows as r_at_5=0", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const payload = {
      ...base,
      evaluated_count: 1,
      answerable_evaluated_count: 0,
      measurement_attribution: {
        ...base.measurement_attribution,
        status: "ineligible",
        gate_eligible: false,
        abstention_calibration_status: "uncalibrated"
      },
      kpi: {
        ...base.kpi,
        r_at_5: 0,
        per_scenario: [
          { id: "q-abstention", version: 1, hit_at_5: false, scorable: false, tier: "cold" }
        ],
        quality_metrics: {
          ...base.kpi.quality_metrics,
          abstention: {
            schema_version: "bench-abstention.v2",
            total: 1,
            scored: 0,
            unscorable: 1,
            method: "fused_margin_diagnostic_only",
            calibration_status: "uncalibrated",
            gate_eligible: false
          }
        }
      }
    };

    expect(() => KpiPayloadSchema.parse(payload)).not.toThrow();
    expect(() => KpiPayloadSchema.parse({
      ...payload,
      kpi: { ...payload.kpi, r_at_5: 1 }
    })).toThrow(/r_at_5/u);
  });

  it("rejects disagreement between answerable count and scenario scoring rows", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const payload = {
      ...base,
      sample_size: 2,
      evaluated_count: 2,
      answerable_evaluated_count: 1,
      kpi: {
        ...base.kpi,
        per_scenario: [
          { id: "q-a", version: 1, hit_at_5: true, scorable: true, tier: "hot" },
          { id: "q-b", version: 1, hit_at_5: false, scorable: true, tier: "cold" }
        ]
      }
    };

    expect(() => KpiPayloadSchema.parse(payload)).toThrow(/answerable_evaluated_count.*scorable/u);
  });

  it("keeps legacy payloads without the new denominator readable", () => {
    const current = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const {
      answerable_evaluated_count: _answerable,
      measurement_attribution: _attribution,
      ...legacy
    } = current;

    expect(() => KpiPayloadSchema.parse(legacy)).not.toThrow();
  });

  it("reads legacy v1 attribution but never treats it as current eligibility", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const legacy = {
      ...base,
      measurement_attribution: {
        schema_version: "bench-measurement-attribution.v1",
        status: "eligible",
        gate_eligible: true,
        evidence_status: "complete",
        candidate_pool_complete: true,
        provenance_complete: true,
        abstention_calibration_status: "not_applicable"
      }
    };

    expect(() => KpiPayloadSchema.parse(legacy)).not.toThrow();
  });

  it("reads legacy abstention evidence but rejects calibrated promotion claims", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const {
      answerable_evaluated_count: _answerable,
      measurement_attribution: _attribution,
      ...legacyBase
    } = base;
    const legacy = {
      ...legacyBase,
      kpi: {
        ...base.kpi,
        quality_metrics: {
          ...base.kpi.quality_metrics,
          abstention: {
            schema_version: "bench-abstention.v1",
            total: 6,
            false_confident_threshold: 0.91,
            correct_at_1: 0,
            correct_at_5: 0,
            correct_at_10: 0,
            false_confident_at_1: 0,
            false_confident_at_5: 0,
            false_confident_at_10: 0
          }
        }
      }
    };
    expect(() => KpiPayloadSchema.parse(legacy)).not.toThrow();

    const forged = {
      ...legacy,
      measurement_attribution: {
        ...base.measurement_attribution,
        abstention_calibration_status: "calibrated"
      }
    };

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/uncalibrated|calibrated/u);
  });

  it.each([
    ["missing abstention metrics", undefined],
    ["zero-total v2", {
      schema_version: "bench-abstention.v2",
      total: 0,
      scored: 0,
      unscorable: 0,
      method: "fused_margin_diagnostic_only",
      calibration_status: "uncalibrated",
      gate_eligible: false
    }]
  ])("rejects unsupported calibrated eligibility with %s", (_label, abstention) => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const forged = {
      ...base,
      measurement_attribution: {
        ...base.measurement_attribution,
        status: "eligible",
        gate_eligible: true,
        abstention_calibration_status: "calibrated"
      },
      kpi: {
        ...base.kpi,
        quality_metrics: abstention === undefined
          ? undefined
          : { ...base.kpi.quality_metrics, abstention }
      }
    };

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/calibrated|not_applicable/u);
  });

  it.each([
    ["missing denominator", undefined, []],
    ["row count mismatch", 1, []],
    ["implicit scorable row", 1, [
      { id: "q-1", version: 1, hit_at_5: true, tier: "hot" }
    ]]
  ])("rejects eligible attribution with %s", (_label, answerable, rows) => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const forged = {
      ...base,
      evaluated_count: 1,
      answerable_evaluated_count: answerable,
      kpi: {
        ...base.kpi,
        per_scenario: rows,
        quality_metrics: {
          ...base.kpi.quality_metrics,
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

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/eligible measurement|scorable|per_scenario/u);
  });

  it("rejects calibrated state even when it does not claim eligibility", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const forged = {
      ...base,
      measurement_attribution: {
        ...base.measurement_attribution,
        status: "ineligible",
        gate_eligible: false,
        evidence_status: "partial",
        candidate_pool_complete: false,
        abstention_calibration_status: "calibrated"
      }
    };

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/calibrated/u);
  });

  it.each([
    ["empty evaluator gold identity", { no_gold_count: 1 }],
    ["unresolved evaluator identity", { evaluator_identity_issue_count: 1 }]
  ])("rejects eligible attribution with %s", (_label, qualityOverride) => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const forged = {
      ...base,
      kpi: {
        ...base.kpi,
        quality_metrics: {
          ...base.kpi.quality_metrics,
          ...qualityOverride
        }
      }
    };

    expect(() => KpiPayloadSchema.parse(forged)).toThrow(/evaluator identity/u);
  });

  it("keeps historical seed-policy vocabulary readable during writer migration", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const historical = {
      ...base,
      seed_policy: {
        mode: "label_independent_all_fact",
        label_independent: true,
        object_kind: "fact",
        description: "historical writer shape"
      }
    };
    const current = {
      ...base,
      seed_policy: {
        mode: "label_independent_open_vocabulary_extraction",
        label_independent: true,
        description: "current writer shape"
      }
    };

    expect(KpiPayloadSchema.parse(historical).seed_policy?.object_kind).toBe("fact");
    expect(KpiPayloadSchema.parse(current).seed_policy).not.toHaveProperty("object_kind");
  });

  it("accounts for evaluator-invalid answerable rows outside the recall denominator", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const payload = {
      ...base,
      evaluated_count: 2,
      answerable_evaluated_count: 1,
      measurement_attribution: {
        ...base.measurement_attribution,
        status: "ineligible",
        gate_eligible: false,
        evidence_status: "partial",
        candidate_pool_complete: false
      },
      kpi: {
        ...base.kpi,
        per_scenario: [
          { id: "q-valid", version: 1, hit_at_5: true, scorable: true, tier: "hot" },
          { id: "q-invalid", version: 1, hit_at_5: false, scorable: false, tier: "cold" }
        ],
        quality_metrics: {
          ...base.kpi.quality_metrics,
          evaluator_identity_issue_count: 1,
          evaluator_identity_issue_denominator: 2,
          evaluator_identity_unscorable_count: 1,
          evaluator_identity_unscorable_denominator: 2,
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

  it("accounts for abstention and evaluator-invalid rows additively", () => {
    const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
    const payload = {
      ...base,
      evaluated_count: 3,
      answerable_evaluated_count: 1,
      measurement_attribution: {
        ...base.measurement_attribution,
        status: "ineligible",
        gate_eligible: false,
        abstention_calibration_status: "uncalibrated",
        evaluator_identity_status: "invalid"
      },
      kpi: {
        ...base.kpi,
        per_scenario: [
          { id: "q-valid", version: 1, hit_at_5: true, scorable: true, tier: "hot" },
          { id: "q-abstention", version: 1, hit_at_5: false, scorable: false, tier: "cold" },
          { id: "q-identity-invalid", version: 1, hit_at_5: false, scorable: false, tier: "cold" }
        ],
        quality_metrics: {
          ...base.kpi.quality_metrics,
          no_gold_count: 1,
          evaluator_identity_unscorable_count: 1,
          evaluator_identity_unscorable_denominator: 3,
          abstention: {
            schema_version: "bench-abstention.v2",
            total: 1,
            scored: 0,
            unscorable: 1,
            method: "fused_margin_diagnostic_only",
            calibration_status: "uncalibrated",
            gate_eligible: false
          }
        }
      }
    };

    expect(() => KpiPayloadSchema.parse(payload)).not.toThrow();
  });
});
