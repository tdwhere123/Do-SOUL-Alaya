import { describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";
import { buildFullLongMemEvalPayload } from "../history/history-fixture.js";

const coverage = {
  gold_bearing_questions: 2,
  full_gold_at_5: 0.5,
  full_gold_at_10: 1,
  gold_coverage_at_5: 0.75,
  gold_coverage_at_10: 1,
  pool_recall_at_50: 1,
  pool_recall_at_100: 1
} as const;

describe("KPI evidence metrics contract", () => {
  it("keeps legacy object-kind and full-gold payloads readable", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.9);
    const parsed = KpiPayloadSchema.parse({
      ...payload,
      kpi: {
        ...payload.kpi,
        full_gold_coverage: coverage,
        quality_metrics: {
          ...payload.kpi.quality_metrics,
          object_kind_delivery: {
            memory_entry: 5,
            synthesis_capsule: 1,
            total_delivered: 6
          }
        }
      }
    });

    expect(parsed.kpi.full_gold_coverage?.memory_only).toBeUndefined();
    expect(parsed.kpi.quality_metrics?.object_kind_delivery).toEqual({
      memory_entry: 5,
      synthesis_capsule: 1,
      evidence_capsule: 0,
      total_delivered: 6
    });
  });

  it("accepts conserved evidence delivery and one-level memory-only coverage", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.9);
    const parsed = KpiPayloadSchema.parse({
      ...payload,
      kpi: {
        ...payload.kpi,
        full_gold_coverage: {
          ...coverage,
          memory_only: { ...coverage, full_gold_at_5: 1 }
        },
        quality_metrics: {
          ...payload.kpi.quality_metrics,
          object_kind_delivery: {
            memory_entry: 5,
            synthesis_capsule: 1,
            evidence_capsule: 2,
            total_delivered: 8
          }
        }
      }
    });

    expect(parsed.kpi.full_gold_coverage?.gold_bearing_questions).toBe(2);
    expect(parsed.kpi.full_gold_coverage?.memory_only?.full_gold_at_5).toBe(1);
    expect(parsed.kpi.quality_metrics?.object_kind_delivery?.evidence_capsule).toBe(2);
  });

  it("rejects object-kind totals that do not conserve delivered objects", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.9);

    expect(() => KpiPayloadSchema.parse({
      ...payload,
      kpi: {
        ...payload.kpi,
        quality_metrics: {
          ...payload.kpi.quality_metrics,
          object_kind_delivery: {
            memory_entry: 5,
            synthesis_capsule: 1,
            evidence_capsule: 2,
            total_delivered: 7
          }
        }
      }
    })).toThrow(/object-kind delivery conservation/u);
  });

  it("rejects recursive memory-only coverage", () => {
    const payload = buildFullLongMemEvalPayload("public", "abc1234", 0.9);

    expect(() => KpiPayloadSchema.parse({
      ...payload,
      kpi: {
        ...payload.kpi,
        full_gold_coverage: {
          ...coverage,
          memory_only: {
            ...coverage,
            memory_only: coverage
          }
        }
      }
    })).toThrow();
  });
});
