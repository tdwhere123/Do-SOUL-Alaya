import {
  evaluateFirstPickTailDegeneracyStream,
  scoreCheapRankingRung,
  type CheapRankingRungReport,
  type CheapRankingRungRow,
  type DeterministicTailPickEvidence,
  type FirstPickTailDegeneracyReport
} from "@do-soul/alaya-core";
import { streamRecallEvalQuestionDiagnostics } from
  "../stage-attribution/load-recall-eval-diagnostics.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../schema/diagnostics-types.js";

export async function evaluateRecallEvalGzipTailDegeneracy(
  artifactPath: string
): Promise<FirstPickTailDegeneracyReport> {
  return evaluateFirstPickTailDegeneracyStream(
    streamCaptureFirstPicks(artifactPath)
  );
}

export async function scoreRecallEvalGzipRankingRung(
  artifactPath: string
): Promise<CheapRankingRungReport> {
  const rows: CheapRankingRungRow[] = [];
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    rows.push(toRungRow(question));
  }
  return scoreCheapRankingRung(rows);
}

async function* streamCaptureFirstPicks(
  artifactPath: string
): AsyncGenerator<DeterministicTailPickEvidence> {
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    const pick = firstPickOf(question);
    if (pick !== null) yield pick;
  }
}

function toRungRow(question: LongMemEvalQuestionDiagnostic): CheapRankingRungRow {
  return {
    question_id: question.question_id,
    any_at_5: question.hit_at_5,
    first_pick: firstPickOf(question)
  };
}

function firstPickOf(
  question: LongMemEvalQuestionDiagnostic
): DeterministicTailPickEvidence | null {
  const pick = question.capture_receipt?.gamma.decisions[0];
  if (pick === undefined) return null;
  return {
    max_g_cohort: pick.max_g_cohort,
    equal_g_dominance_rejects: pick.equal_g_dominance_rejects
  };
}
