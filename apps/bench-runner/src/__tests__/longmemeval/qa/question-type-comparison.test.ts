import { describe, expect, it } from "vitest";
import {
  compareLongMemEvalQuestionTypes,
  renderQuestionTypeComparisonMarkdown,
  type QuestionTypeComparison
} from "../../../longmemeval/comparison/question-type-comparison.js";
import {
  DATASET_SHA,
  dataset,
  datasetQuestion,
  kpi,
  provenance
} from "./question-type-comparison-test-fixtures.js";

function buildGainAndLossComparison(): QuestionTypeComparison {
  return compareLongMemEvalQuestionTypes({
    dataset,
    datasetSha256: DATASET_SHA,
    control: kpi([
      { id: "a-gained", hit_at_5: false },
      { id: "b-lost", hit_at_5: true },
      { id: "c-still-hit", hit_at_5: true },
      { id: "d-still-miss_abs", hit_at_5: false }
    ]),
    treatment: kpi([
      { id: "d-still-miss_abs", hit_at_5: false },
      { id: "c-still-hit", hit_at_5: true },
      { id: "b-lost", hit_at_5: false },
      { id: "a-gained", hit_at_5: true }
    ], 104),
    controlProvenance: provenance(false),
    treatmentProvenance: provenance(true)
  });
}

function expectQuestionTypeRows(comparison: QuestionTypeComparison): void {
  expect(comparison.overall).toEqual({
    control: { hits: 2, total: 4, any_at_5: 0.5 },
    treatment: { hits: 2, total: 4, any_at_5: 0.5 },
    delta_hits: 0,
    delta_any_at_5: 0
  });
  expect(comparison.question_types).toEqual([
    {
      question_type: "multi-session",
      control: { hits: 2, total: 2, any_at_5: 1 },
      treatment: { hits: 1, total: 2, any_at_5: 0.5 },
      delta_hits: -1,
      delta_any_at_5: -0.5
    },
    {
      question_type: "single-session-user",
      control: { hits: 0, total: 2, any_at_5: 0 },
      treatment: { hits: 1, total: 2, any_at_5: 0.5 },
      delta_hits: 1,
      delta_any_at_5: 0.5
    }
  ]);
}

function expectAnswerabilityRows(comparison: QuestionTypeComparison): void {
  expect(comparison.answerability).toEqual([
    {
      cohort: "answerable",
      metric_kind: "gold_identity",
      calibration_status: "not_applicable",
      total: 3,
      control: { hits: 2, total: 3, any_at_5: 0.666667 },
      treatment: { hits: 2, total: 3, any_at_5: 0.666667 },
      delta_hits: 0,
      delta_any_at_5: 0
    },
    {
      cohort: "abstention",
      metric_kind: "abstention_fused_margin_heuristic",
      calibration_status: "uncalibrated",
      total: 1,
      control: { hits: 0, total: 1, any_at_5: 0 },
      treatment: { hits: 0, total: 1, any_at_5: 0 },
      delta_hits: 0,
      delta_any_at_5: 0
    }
  ]);
}

function expectGateAndFlips(comparison: QuestionTypeComparison): void {
  expect(comparison.flips).toEqual({
    gained: { count: 1, question_ids: ["a-gained"] },
    lost: { count: 1, question_ids: ["b-lost"] },
    net: 0
  });
  expect(comparison.latency).toEqual({
    control_p95_ms: 100,
    treatment_p95_ms: 104,
    treatment_to_control_ratio: 1.04,
    within_105_percent: true
  });
  expect(comparison.gate).toMatchObject({
    evaluation_scope: "answerable_gold_bearing",
    abstention_heuristic_calibrated: false,
    gold_bearing_gain: false,
    question_type_non_regression: false,
    regressed_question_types: ["multi-session"],
    pass: false
  });
}

function expectMixedCohortLabels(comparison: QuestionTypeComparison): void {
  const rendered = renderQuestionTypeComparisonMarkdown(comparison);
  expect(rendered).toContain("Question type (mixed cohort, non-gating)");
  expect(rendered).toContain(
    "Question-type rows below mix answerable gold-identity and uncalibrated abstention-heuristic cohorts; they are diagnostic only and never gate promotion."
  );
  expect(rendered).toContain("Regressed question types: multi-session");
  expect(rendered).toContain("Gate evaluation scope: answerable_gold_bearing.");
  expect(rendered).toContain("| answerable | gold_identity | not_applicable |");
  expect(rendered).toContain(
    "| abstention | abstention_fused_margin_heuristic | uncalibrated |"
  );
}

describe("LongMemEval question-type comparison reporting", () => {
  it("reports paired gains, losses, and per-type hit counts", () => {
    const comparison = buildGainAndLossComparison();
    expectQuestionTypeRows(comparison);
    expectAnswerabilityRows(comparison);
    expectGateAndFlips(comparison);
    expectMixedCohortLabels(comparison);
  });

  it("keeps uncalibrated abstention changes out of the promotion gate", () => {
    const separatedDataset = [
      datasetQuestion("a-gained", "single-session-user"),
      datasetQuestion("b-still-hit", "multi-session"),
      datasetQuestion("c-lost_abs", "single-session-user"),
      datasetQuestion("d-lost_abs", "multi-session")
    ];
    const comparison = compareLongMemEvalQuestionTypes({
      dataset: separatedDataset,
      datasetSha256: DATASET_SHA,
      control: kpi([
        { id: "a-gained", hit_at_5: false },
        { id: "b-still-hit", hit_at_5: true },
        { id: "c-lost_abs", hit_at_5: true },
        { id: "d-lost_abs", hit_at_5: true }
      ]),
      treatment: kpi([
        { id: "a-gained", hit_at_5: true },
        { id: "b-still-hit", hit_at_5: true },
        { id: "c-lost_abs", hit_at_5: false },
        { id: "d-lost_abs", hit_at_5: false }
      ]),
      controlProvenance: provenance(false),
      treatmentProvenance: provenance(true)
    });

    expect(comparison.overall.delta_hits).toBe(-1);
    expect(comparison.answerability).toEqual(expect.arrayContaining([
      expect.objectContaining({ cohort: "answerable", delta_hits: 1 }),
      expect.objectContaining({ cohort: "abstention", delta_hits: -2 })
    ]));
    expect(comparison.gate).toMatchObject({
      evaluation_scope: "answerable_gold_bearing",
      abstention_heuristic_calibrated: false,
      gold_bearing_gain: true,
      pass: true
    });
  });

});

describe("LongMemEval question-type comparison gate", () => {

  it("rejects failing latency", () => {
    const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
    const comparison = compareLongMemEvalQuestionTypes({
      dataset,
      datasetSha256: DATASET_SHA,
      control: kpi(rows, 100),
      treatment: kpi(rows, 106),
      controlProvenance: provenance(false),
      treatmentProvenance: provenance(true)
    });
    expect(comparison.latency.within_105_percent).toBe(false);
    expect(comparison.gate?.pass).toBe(false);
  });

  it("passes only when quality, latency, and every question type are non-regressing", () => {
    const comparison = compareLongMemEvalQuestionTypes({
      dataset,
      datasetSha256: DATASET_SHA,
      control: kpi([
        { id: "a-gained", hit_at_5: false },
        { id: "b-lost", hit_at_5: true },
        { id: "c-still-hit", hit_at_5: true },
        { id: "d-still-miss_abs", hit_at_5: false }
      ]),
      treatment: kpi([
        { id: "a-gained", hit_at_5: true },
        { id: "b-lost", hit_at_5: true },
        { id: "c-still-hit", hit_at_5: true },
        { id: "d-still-miss_abs", hit_at_5: false }
      ], 105),
      controlProvenance: provenance(false),
      treatmentProvenance: provenance(true)
    });
    expect(comparison.gate).toMatchObject({
      gold_bearing_gain: true,
      any_at_5_non_decreasing: true,
      latency_within_105_percent: true,
      question_type_non_regression: true,
      regressed_question_types: [],
      pass: true
    });
  });
});
