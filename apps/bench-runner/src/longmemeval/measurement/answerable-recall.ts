import type { LongMemEvalQuestionDiagnostic } from "../diagnostics-types.js";
import { classifyQuestionMeasurementStatus } from "./question-validity.js";

export interface AnswerableRecallSummary {
  readonly scorableCount: number;
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
}

export function summarizeAnswerableRecall(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): AnswerableRecallSummary {
  let scorableCount = 0;
  let hitsAt1 = 0;
  let hitsAt5 = 0;
  let hitsAt10 = 0;
  for (const diagnostic of diagnostics) {
    if (classifyQuestionMeasurementStatus(diagnostic) !== "scorable") continue;
    scorableCount += 1;
    if (diagnostic.hit_at_1) hitsAt1 += 1;
    if (diagnostic.hit_at_5) hitsAt5 += 1;
    if (diagnostic.hit_at_10) hitsAt10 += 1;
  }
  return {
    scorableCount,
    rAt1: ratio(hitsAt1, scorableCount),
    rAt5: ratio(hitsAt5, scorableCount),
    rAt10: ratio(hitsAt10, scorableCount)
  };
}

export function answerableRecallAt5(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): number {
  return summarizeAnswerableRecall(diagnostics).rAt5;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
