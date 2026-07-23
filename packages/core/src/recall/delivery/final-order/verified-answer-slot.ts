import type { RecallCandidate } from "@do-soul/alaya-protocol";
import type {
  RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import {
  buildRecallCandidateSelectionKey
} from "../../runtime/recall-candidate-builder.js";

const ANSWER_SLOT_INDEX = 4;
const SEARCH_LIMIT = 10;

export function orderWithVerifiedAnswerSlot(params: Readonly<{
  readonly publicOrder: readonly Readonly<RecallCandidate>[];
  readonly supportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
}>): readonly Readonly<RecallCandidate>[] {
  if (params.publicOrder.length <= ANSWER_SLOT_INDEX + 1) return params.publicOrder;
  if (params.publicOrder.slice(0, ANSWER_SLOT_INDEX + 1).some((candidate) =>
    isBehaviorEligible(candidate, params.supportByCandidateKey)
  )) return params.publicOrder;
  const eligibleIndexes = params.publicOrder
    .slice(ANSWER_SLOT_INDEX + 1, SEARCH_LIMIT)
    .flatMap((candidate, index) =>
      isBehaviorEligible(candidate, params.supportByCandidateKey)
        ? [index + ANSWER_SLOT_INDEX + 1]
        : []
    );
  if (eligibleIndexes.length !== 1) return params.publicOrder;
  const answerIndex = eligibleIndexes[0]!;
  return Object.freeze([
    ...params.publicOrder.slice(0, ANSWER_SLOT_INDEX),
    params.publicOrder[answerIndex]!,
    ...params.publicOrder.slice(ANSWER_SLOT_INDEX, answerIndex),
    ...params.publicOrder.slice(answerIndex + 1)
  ]);
}

function isBehaviorEligible(
  candidate: Readonly<RecallCandidate>,
  supportByCandidateKey: ReadonlyMap<string, Readonly<RecallCandidateAnswerSupport>>
): boolean {
  return supportByCandidateKey.get(
    buildRecallCandidateSelectionKey(candidate)
  )?.authority?.behavior_eligible === true;
}
