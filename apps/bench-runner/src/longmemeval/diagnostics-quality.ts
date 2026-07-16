import type { QualityMetrics } from "@do-soul/alaya-eval";
import type {
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";
import {
  createQualityMetricsState,
  recordQualityQuestion
} from "./diagnostics-quality-state.js";
import { buildQualityMetricsFromState } from "./diagnostics-quality-render.js";
import { classifyQuestionMeasurementCohort } from
  "./measurement/question-validity.js";
export { buildPerPlaneRecallCoverage } from "./diagnostics-quality-helpers.js";

export function buildLongMemEvalQualityMetrics(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): QualityMetrics {
  const state = createQualityMetricsState();
  for (const question of diagnostics) {
    recordQualityQuestion(state, question);
  }
  const answerableCount = diagnostics.filter(
    (question) => classifyQuestionMeasurementCohort(question) === "answerable"
  ).length;
  return buildQualityMetricsFromState(state, answerableCount, diagnostics.length);
}
