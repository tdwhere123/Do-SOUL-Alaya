import type { KpiPayload, PerScenarioRow } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import { buildLongMemEvalDetailedGoldCoverage } from
  "../../longmemeval/diagnostics/diagnostics-full-gold-coverage.js";

export function buildMergedFullGoldCoverage(
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[],
  perScenario: readonly PerScenarioRow[]
): KpiPayload["kpi"]["full_gold_coverage"] | undefined {
  if (!hasModernFullGoldDiagnosticsSet(questionDiagnostics, perScenario)) {
    return undefined;
  }
  return buildLongMemEvalDetailedGoldCoverage(questionDiagnostics);
}

function hasModernFullGoldDiagnosticsSet(
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[],
  perScenario: readonly PerScenarioRow[]
): boolean {
  if (!hasExactQuestionDiagnosticsSet(questionDiagnostics, perScenario)) {
    return false;
  }
  return questionDiagnostics.every((question) => Array.isArray(question.gold));
}

function hasExactQuestionDiagnosticsSet(
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[],
  perScenario: readonly PerScenarioRow[]
): boolean {
  if (questionDiagnostics.length !== perScenario.length) return false;
  const expected = new Set(perScenario.map((row) => row.id));
  if (expected.size !== perScenario.length) return false;
  const seen = new Set<string>();
  for (const question of questionDiagnostics) {
    if (!expected.has(question.question_id) || seen.has(question.question_id)) {
      return false;
    }
    seen.add(question.question_id);
  }
  return seen.size === expected.size;
}
