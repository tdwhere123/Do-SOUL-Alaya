import type { RecallCandidate } from "@do-soul/alaya-protocol";
import type {
  RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import { buildRecallCandidateSelectionKey } from "../../runtime/recall-candidate-builder.js";
import { orderWithBoundedHeadDisplacement } from "./bounded-head-displacement.js";
import { orderWithVerifiedAnswerSlot } from "./verified-answer-slot.js";

type FinalAuthorityOrder = "public_relevance" | "delivery_rank";

export function orderByFinalAuthority(params: Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly finalOrder: FinalAuthorityOrder;
  readonly deliveryRankByCandidateKey: ReadonlyMap<string, number>;
  readonly maxHeadDrop?: number;
  readonly protectedRankLimit: number;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
}>): readonly Readonly<RecallCandidate>[] {
  const publicOrder = [...params.candidates].sort((left, right) =>
    compareFinalDeliveryOrder(
      left, right, params.finalOrder, params.deliveryRankByCandidateKey
    ));
  const boundedOrder =
    params.finalOrder === "public_relevance" && params.maxHeadDrop !== undefined
      ? orderWithBoundedHeadDisplacement({
          publicOrder,
          headRankByKey: params.deliveryRankByCandidateKey,
          keyOf: buildRecallCandidateSelectionKey,
          maxDownwardDisplacement: params.maxHeadDrop,
          protectedRankLimit: params.protectedRankLimit
        })
      : publicOrder;
  return params.finalOrder === "public_relevance"
    ? orderWithVerifiedAnswerSlot({
        publicOrder: boundedOrder,
        supportByCandidateKey: params.answerSupportByCandidateKey
      })
    : boundedOrder;
}

function compareFinalDeliveryOrder(
  left: Readonly<RecallCandidate>,
  right: Readonly<RecallCandidate>,
  finalOrder: FinalAuthorityOrder,
  deliveryRankByCandidateKey: ReadonlyMap<string, number>
): number {
  const leftKey = buildRecallCandidateSelectionKey(left);
  const rightKey = buildRecallCandidateSelectionKey(right);
  if (finalOrder === "delivery_rank") {
    return (deliveryRankByCandidateKey.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
      (deliveryRankByCandidateKey.get(rightKey) ?? Number.MAX_SAFE_INTEGER) ||
      leftKey.localeCompare(rightKey);
  }
  return right.relevance_score - left.relevance_score || leftKey.localeCompare(rightKey);
}
