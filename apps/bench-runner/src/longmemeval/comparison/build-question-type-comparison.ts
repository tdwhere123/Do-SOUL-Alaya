import { Buffer } from "node:buffer";
import type { LongMemEvalQuestion } from "../dataset.js";
import { isAbstentionQuestionId } from "../abstention.js";
import type {
  AnswerabilitySummary,
  ComparisonSummary,
  HitRateSummary,
  QuestionTypeComparison,
  QuestionTypeSummary
} from "./question-type-comparison.js";

export interface DatasetRow {
  readonly questionId: string;
  readonly questionType: string;
  readonly question: LongMemEvalQuestion;
}

export interface PairedRow extends DatasetRow {
  readonly controlHit: boolean;
  readonly treatmentHit: boolean;
}

export function buildQuestionTypeComparison(
  rows: readonly PairedRow[],
  controlP95: number,
  treatmentP95: number,
  grade: QuestionTypeComparison["evidence_grade"]
): QuestionTypeComparison {
  const questionTypes = [...new Set(rows.map((row) => row.questionType))].sort(bytewiseCompare);
  const answerableRows = rows.filter(isAnswerable);
  const answerable = summarizeComparison(answerableRows);
  const latency = buildLatency(controlP95, treatmentP95);
  const questionTypeRows = buildQuestionTypeRows(rows, questionTypes);
  const flips = buildFlips(rows);
  return {
    schema_version: 2,
    evidence_grade: grade,
    question_count: rows.length,
    overall: summarizeComparison(rows),
    question_types: questionTypeRows,
    answerability: buildAnswerability(rows),
    latency,
    gate: buildGate(grade, answerableRows, answerable, latency),
    flips
  };
}

function buildAnswerability(rows: readonly PairedRow[]): readonly AnswerabilitySummary[] {
  return (["answerable", "abstention"] as const).map((cohort) => {
    const selected = rows.filter((row) => isAnswerable(row) === (cohort === "answerable"));
    return {
      cohort,
      metric_kind: cohort === "answerable"
        ? "gold_identity" as const
        : "abstention_fused_margin_heuristic" as const,
      calibration_status: cohort === "answerable" ? "not_applicable" as const : "uncalibrated" as const,
      total: selected.length,
      ...summarizeComparison(selected)
    };
  });
}

function buildGate(
  grade: QuestionTypeComparison["evidence_grade"],
  answerableRows: readonly PairedRow[],
  answerable: ComparisonSummary,
  latency: QuestionTypeComparison["latency"]
): QuestionTypeComparison["gate"] {
  if (grade === "legacy_unattributed") return null;
  const questionTypes = [...new Set(answerableRows.map((row) => row.questionType))];
  const regressed = buildQuestionTypeRows(answerableRows, questionTypes)
    .filter((row) => row.delta_hits < 0)
    .map((row) => row.question_type);
  const goldBearingGain = answerable.delta_hits >= 1;
  const nonRegression = regressed.length === 0;
  return {
    evaluation_scope: "answerable_gold_bearing",
    abstention_heuristic_calibrated: false,
    gold_bearing_gain: goldBearingGain,
    any_at_5_non_decreasing: answerable.delta_hits >= 0,
    latency_within_105_percent: latency.within_105_percent,
    question_type_non_regression: nonRegression,
    regressed_question_types: regressed,
    pass: goldBearingGain && answerable.delta_hits >= 0 &&
      latency.within_105_percent && nonRegression
  };
}

function buildFlips(rows: readonly PairedRow[]): QuestionTypeComparison["flips"] {
  const gained = rows.filter((row) => !row.controlHit && row.treatmentHit)
    .map((row) => row.questionId).sort(bytewiseCompare);
  const lost = rows.filter((row) => row.controlHit && !row.treatmentHit)
    .map((row) => row.questionId).sort(bytewiseCompare);
  return {
    gained: { count: gained.length, question_ids: gained },
    lost: { count: lost.length, question_ids: lost },
    net: gained.length - lost.length
  };
}

function buildQuestionTypeRows(
  rows: readonly PairedRow[],
  questionTypes: readonly string[]
): readonly QuestionTypeSummary[] {
  return [...questionTypes].sort(bytewiseCompare).map((questionType) => ({
    question_type: questionType,
    ...summarizeComparison(rows.filter((row) => row.questionType === questionType))
  }));
}

function buildLatency(
  controlP95: number,
  treatmentP95: number
): QuestionTypeComparison["latency"] {
  const ratio = controlP95 === 0
    ? (treatmentP95 === 0 ? 1 : null)
    : round6(treatmentP95 / controlP95);
  return {
    control_p95_ms: controlP95,
    treatment_p95_ms: treatmentP95,
    treatment_to_control_ratio: ratio,
    within_105_percent: treatmentP95 <= controlP95 * 1.05
  };
}

function summarizeComparison(rows: readonly PairedRow[]): ComparisonSummary {
  const controlHits = rows.filter((row) => row.controlHit).length;
  const treatmentHits = rows.filter((row) => row.treatmentHit).length;
  const control = hitRate(controlHits, rows.length);
  const treatment = hitRate(treatmentHits, rows.length);
  return {
    control,
    treatment,
    delta_hits: treatmentHits - controlHits,
    delta_any_at_5: round6(treatment.any_at_5 - control.any_at_5)
  };
}

function hitRate(hits: number, total: number): HitRateSummary {
  return { hits, total, any_at_5: total === 0 ? 0 : round6(hits / total) };
}

function isAnswerable(row: DatasetRow): boolean {
  return !isAbstentionQuestionId(row.questionId);
}

function round6(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : value;
}

export function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
