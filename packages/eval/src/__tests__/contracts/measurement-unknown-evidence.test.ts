import { expect, it } from "vitest";
import { KpiPayloadSchema } from "../../contracts/kpi-schema.js";
import { QualityMetricsSchema } from "../../contracts/kpi-quality-schema.js";
import { QaMetricsSchema } from "../../contracts/kpi-auxiliary-schema.js";
import { collectReleaseHardGates } from "../../gates/release-gates.js";
import { renderAbsoluteKpis } from "../../reports/report-absolute-kpis.js";
import { buildFullLongMemEvalPayload } from "../history/history-fixture.js";

it("retains reconstructed cohorts while unknown quality facets fail numeric gates and remain unavailable in reports", () => {
  const payload = buildFullLongMemEvalPayload("public", "05d98df", 1);
  const prior = payload.kpi.quality_metrics!;
  payload.measurement_attribution = undefined;
  payload.kpi.quality_metrics = QualityMetricsSchema.parse({
    schema_version: "bench-quality-metrics.unavailable.v1", unavailable_reason: "not_recomputed_from_shard_archives",
    measurement_cohort_counts: prior.measurement_cohort_counts,
    unscorable_reason_distribution: prior.unscorable_reason_distribution, abstention: prior.abstention
  });
  expect(KpiPayloadSchema.safeParse(payload).success).toBe(true);
  expect(payload.kpi.quality_metrics).not.toHaveProperty("non_monotonic_count");
  const lines: string[] = [];
  renderAbsoluteKpis(lines, payload);
  expect(lines.join("\n")).toContain("Quality metrics: unavailable");
  expect(collectReleaseHardGates(payload).find((gate) => gate.id === "longmemeval_s_no_gold"))
    .toMatchObject({ current: null, missing: true, passed: false });
  expect(QualityMetricsSchema.safeParse({ ...payload.kpi.quality_metrics, no_gold_count: 0 }).success).toBe(false);
});

it("distinguishes a valid negative judge verdict from missing evaluator evidence without shrinking the attempted cohort", () => {
  const negative = { qa_total: 1, qa_correct: 0, qa_accuracy: 0, qa_abstention_total: 0, qa_abstention_correct: 0,
    qa_by_type: { factual: { total: 1, correct: 0 } }, answer_model: "authored-answer", judge_model: "authored-judge" };
  expect(QaMetricsSchema.safeParse(negative).success).toBe(true);
  expect(QaMetricsSchema.safeParse({ ...negative, qa_accuracy: null, qa_invalid_judge_count: 1,
    qa_invalid_judgments: [{ question_id: "q", validity: "empty", raw_verdict: "" }] }).success).toBe(true);
  expect(QaMetricsSchema.safeParse({ ...negative, qa_invalid_judge_count: 1 }).success).toBe(false);
  expect(QaMetricsSchema.safeParse({ ...negative, qa_total: 0, qa_accuracy: null, qa_invalid_judge_count: 1 }).success).toBe(false);
});
