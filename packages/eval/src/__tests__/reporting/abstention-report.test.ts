import { describe, expect, it } from "vitest";
import { renderAbsoluteKpis } from "../../reporting/report-absolute-kpis.js";
import { QualityMetricsSchema } from "../../schema/kpi-quality-schema.js";
import {
  buildPayload,
  passingQualityMetrics
} from "../history/history-fixture.js";

describe("abstention report contract", () => {
  it("labels the shared top-5 fused-margin verdict as uncalibrated", () => {
    const payload = buildPayload("05d98df");
    payload.kpi.quality_metrics = {
      ...passingQualityMetrics(),
      abstention: {
        schema_version: "bench-abstention.v1",
        total: 2,
        false_confident_threshold: 0.91,
        correct_at_1: 1,
        correct_at_5: 1,
        correct_at_10: 1,
        false_confident_at_1: 1,
        false_confident_at_5: 1,
        false_confident_at_10: 1
      }
    };
    const lines: string[] = [];

    renderAbsoluteKpis(lines, payload);

    expect(lines.join("\n")).toContain(
      "Abstention (uncalibrated fused-margin heuristic, shared top-5 verdict"
    );
    expect(lines.find((line) => line.startsWith("- Abstention"))).toBe(
      "- Abstention (uncalibrated fused-margin heuristic, shared top-5 verdict, threshold=0.91): 2 questions, correct@1=1 correct@5=1 correct@10=1; these compatibility counts carry the same question-level verdict and are credited to each recall@k numerator (denominator unchanged)."
    );
    expect(lines.join("\n")).not.toContain("calibrated confidence");
  });

  it("keeps the legacy v1 reader shape unchanged", () => {
    const abstention = {
      schema_version: "bench-abstention.v1" as const,
      total: 1,
      false_confident_threshold: 0.91,
      correct_at_1: 0,
      correct_at_5: 0,
      correct_at_10: 0,
      false_confident_at_1: 1,
      false_confident_at_5: 1,
      false_confident_at_10: 1
    };
    const parsed = QualityMetricsSchema.parse({
      ...passingQualityMetrics(),
      abstention
    });

    expect(parsed.abstention).toEqual(abstention);
  });

  it("renders v2 as uncalibrated and never gate eligible", () => {
    const payload = buildPayload("05d98df");
    payload.kpi.quality_metrics = {
      ...passingQualityMetrics(),
      abstention: {
        schema_version: "bench-abstention.v2",
        total: 2,
        scored: 0,
        unscorable: 2,
        method: "fused_margin_diagnostic_only",
        calibration_status: "uncalibrated",
        gate_eligible: false
      }
    };
    const lines: string[] = [];

    expect(QualityMetricsSchema.parse(payload.kpi.quality_metrics).abstention)
      .toMatchObject({ schema_version: "bench-abstention.v2", gate_eligible: false });
    renderAbsoluteKpis(lines, payload);

    expect(lines.join("\n")).toContain(
      "Abstention (uncalibrated, diagnostic-only): 2 questions, scored=0 unscorable=2 gate_eligible=false"
    );
  });

  it("fails loud on unknown abstention schema versions", () => {
    expect(() => QualityMetricsSchema.parse({
      ...passingQualityMetrics(),
      abstention: { schema_version: "bench-abstention.v3", total: 1 }
    })).toThrow();
  });

  it("renders evaluator identity exclusions beside other quality evidence", () => {
    const payload = buildPayload("05d98df");
    payload.kpi.quality_metrics = {
      ...passingQualityMetrics(),
      evaluator_identity_issue_count: 2,
      evaluator_identity_unscorable_count: 3
    };
    const lines: string[] = [];

    expect(() => QualityMetricsSchema.parse(payload.kpi.quality_metrics)).not.toThrow();
    renderAbsoluteKpis(lines, payload);

    expect(lines.join("\n")).toContain(
      "evaluator_identity_issue=2 evaluator_identity_unscorable=3"
    );
  });

  it("renders conserved measurement cohorts separately from unscorable reasons", () => {
    const payload = buildPayload("05d98df");
    payload.kpi.quality_metrics = {
      ...passingQualityMetrics(),
      measurement_cohort_counts: {
        evaluated: 8,
        non_abstention: 7,
        abstention: 1,
        scorable_answerable: 4,
        unscorable_answerable: 3,
        hit_at_5: 3,
        miss_at_5: 1
      },
      evaluator_identity_unscorable_count: 3,
      abstention: {
        schema_version: "bench-abstention.v2",
        total: 1,
        scored: 0,
        unscorable: 1,
        method: "fused_margin_diagnostic_only",
        calibration_status: "uncalibrated",
        gate_eligible: false
      },
      unscorable_reason_distribution: {
        abstention_uncalibrated: 1,
        empty_gold_identity: 3
      },
      miss_taxonomy_distribution: {
        ...passingQualityMetrics().miss_taxonomy_distribution,
        delivery_order_drop: 1
      }
    };
    const lines: string[] = [];

    expect(() => QualityMetricsSchema.parse(payload.kpi.quality_metrics)).not.toThrow();
    renderAbsoluteKpis(lines, payload);

    expect(lines).toContain(
      "- Measurement cohorts: evaluated=8 non_abstention=7 abstention=1 scorable_answerable=4 unscorable_answerable=3 hit_at_5=3 miss_at_5=1"
    );
    expect(lines).toContain(
      "- Unscorable reasons: abstention_uncalibrated=1 empty_gold_identity=3"
    );
  });

  it("rejects measurement cohort counts that do not conserve", () => {
    expect(() => QualityMetricsSchema.parse({
      ...passingQualityMetrics(),
      measurement_cohort_counts: {
        evaluated: 8,
        non_abstention: 7,
        abstention: 1,
        scorable_answerable: 5,
        unscorable_answerable: 3,
        hit_at_5: 3,
        miss_at_5: 1
      }
    })).toThrow(/measurement cohort conservation/iu);
  });
});
