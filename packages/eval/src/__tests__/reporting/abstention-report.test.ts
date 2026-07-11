import { describe, expect, it } from "vitest";
import { renderAbsoluteKpis } from "../../reporting/report-absolute-kpis.js";
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
    expect(lines.join("\n")).not.toContain("calibrated confidence");
  });
});
