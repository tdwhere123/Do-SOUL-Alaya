import { appendFileSync } from "node:fs";
import type { LongMemEvalQuestion } from "../../../ingestion/dataset.js";
import type { QaDeliveredCandidate, QaQuestionVerdict } from "../../../qa/qa-harness.js";
import { normalizeQaDeliveryContent } from "./qa-delivery-content.js";

export interface QaDeliveryDiagnosticInput {
  readonly dumpPath: string;
  readonly question: LongMemEvalQuestion;
  readonly qaVerdict: QaQuestionVerdict;
  readonly goldMemoryIds: readonly string[];
  readonly memoryEntryCandidates: readonly QaDeliveredCandidate[];
  readonly delivered: readonly QaDeliveredCandidate[];
}

// This distinguishes missing recall evidence from reader errors without changing
// the delivered context, making each failing QA question independently inspectable.
export function dumpQaDeliveryDiagnostic(input: QaDeliveryDiagnosticInput): void {
  appendFileSync(input.dumpPath, `${JSON.stringify(buildQaDeliveryDiagnosticRecord(input))}\n`);
}

function buildQaDeliveryDiagnosticRecord(input: QaDeliveryDiagnosticInput) {
  const diagnostic = inspectQaDeliveryFailure(input);
  return {
    questionId: input.question.question_id,
    questionType: input.question.question_type,
    question: input.question.question,
    questionDate: input.question.question_date,
    goldAnswer: input.question.answer,
    modelAnswer: input.qaVerdict.modelAnswer,
    judgeVerdict: input.qaVerdict.judgeVerdict,
    correct: input.qaVerdict.correct,
    ...diagnostic,
    deliveredGoldOnly: process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined,
    delivered: input.delivered.map((candidate) => ({
      objectId: candidate.objectId,
      ...(candidate.eventDate === undefined ? {} : { eventDate: candidate.eventDate }),
      ...(candidate.sessionId == null ? {} : { sessionId: candidate.sessionId }),
      ...(candidate.sourceRank === undefined ? {} : { sourceRank: candidate.sourceRank }),
      content: candidate.content.replace(/\s+/gu, " ")
    }))
  };
}

function inspectQaDeliveryFailure(input: QaDeliveryDiagnosticInput) {
  const goldIdSet = new Set(input.goldMemoryIds);
  const widePoolGoldRanks = input.memoryEntryCandidates
    .filter((candidate) =>
      goldIdSet.has(candidate.objectId) && normalizeQaDeliveryContent(candidate.content).length > 0
    )
    .map((candidate) => candidate.sourceRank);
  const goldInWidePool = widePoolGoldRanks.length > 0;
  const goldInDelivered = input.delivered.some((candidate) => goldIdSet.has(candidate.objectId));
  const failureClass = input.qaVerdict.correct
    ? null
    : !goldInWidePool
      ? "recall_miss"
      : !goldInDelivered
        ? "support_selector_miss"
        : "reader_miss";
  return { goldInWidePool, goldInDelivered, failureClass, widePoolGoldRanks };
}
