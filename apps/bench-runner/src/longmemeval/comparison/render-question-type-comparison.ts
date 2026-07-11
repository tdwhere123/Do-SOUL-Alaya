import type {
  HitRateSummary,
  QuestionTypeComparison
} from "./question-type-comparison.js";

export function renderQuestionTypeComparisonMarkdown(
  comparison: QuestionTypeComparison
): string {
  const answerable = comparison.answerability.find((row) => row.cohort === "answerable");
  const lines = [
    "# LongMemEval Question-Type Comparison",
    "",
    `Evidence: ${comparison.evidence_grade}.`,
    `Overall: control ${formatRate(comparison.overall.control)}, treatment ${formatRate(comparison.overall.treatment)}, delta ${formatDelta(comparison.overall.delta_any_at_5)}.`,
    `Latency p95: control ${comparison.latency.control_p95_ms}ms, treatment ${comparison.latency.treatment_p95_ms}ms, <=105% ${comparison.latency.within_105_percent}.`,
    `Gate: ${comparison.gate === null ? "not eligible" : comparison.gate.pass ? "pass" : "fail"}.`,
    `Gate evaluation scope: ${comparison.gate?.evaluation_scope ?? "not eligible"}.`,
    `Answerable gate delta: ${answerable === undefined ? "unavailable" : `${formatHitDelta(answerable.delta_hits)} hits (${formatDelta(answerable.delta_any_at_5)} any@5)`}.`,
    "Overall and flips are mixed-cohort diagnostics only; the gate ignores them.",
    `Regressed question types: ${comparison.gate?.regressed_question_types.join(", ") || "none"}.`,
    `Flips: gained ${comparison.flips.gained.count}, lost ${comparison.flips.lost.count}, net ${comparison.flips.net}.`,
    "",
    "Question-type rows below mix answerable gold-identity and uncalibrated abstention-heuristic cohorts; they are diagnostic only and never gate promotion.",
    "",
    "| Question type (mixed cohort, non-gating) | Control hits/N (any@5) | Treatment hits/N (any@5) | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...comparison.question_types.map((row) =>
      `| ${row.question_type} | ${formatRate(row.control)} | ${formatRate(row.treatment)} | ${formatDelta(row.delta_any_at_5)} |`
    ),
    "",
    "| Cohort | Metric kind | Calibration | Control hits/N (any@5) | Treatment hits/N (any@5) | Delta |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...comparison.answerability.map((row) =>
      `| ${row.cohort} | ${row.metric_kind} | ${row.calibration_status} | ${formatRate(row.control)} | ${formatRate(row.treatment)} | ${formatDelta(row.delta_any_at_5)} |`
    ),
    "",
    `Gained question IDs: ${comparison.flips.gained.question_ids.join(", ") || "none"}`,
    `Lost question IDs: ${comparison.flips.lost.question_ids.join(", ") || "none"}`
  ];
  return `${lines.join("\n")}\n`;
}

function formatRate(value: HitRateSummary): string {
  return `${value.hits}/${value.total} (${value.any_at_5.toFixed(6)})`;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(6)}`;
}

function formatHitDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}
