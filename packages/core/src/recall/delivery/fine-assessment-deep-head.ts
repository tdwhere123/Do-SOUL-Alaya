import {
  resolveDeepHeadAssessment,
  type RecallDeepHeadAssessment
} from "../rerank/deep-head.js";
import { createRecallRelevanceUpperBoundReceipt } from
  "../rerank/relevance-upper-bound-receipt.js";
import type { DeliverySelectionCandidate } from "./delivery-selection.js";

const EMPTY_DEEP_HEAD_SCORES: ReadonlyMap<string, number> = new Map();
const INDEPENDENT_EMBEDDING_DELIVERY_OPERATOR_ID =
  "independent_embedding_delivery_v1";

export type FineAssessmentDeepHeadDelivery = Readonly<{
  readonly orderScores: ReadonlyMap<string, number>;
  readonly coverageRelevance: ReadonlyMap<string, number>;
  readonly coverageRelevanceUpperBound: RecallDeepHeadAssessment["relevanceUpperBoundReceipt"];
}>;

/** Independent embedding may rescore; lexical/evidence residual must not replace R_obj. */
export function composeFineAssessmentDeepHeadDelivery(
  deepHead: RecallDeepHeadAssessment
): FineAssessmentDeepHeadDelivery {
  const embeddingScores = deepHead.independentEmbeddingScores;
  if (embeddingScores.size === 0) {
    return Object.freeze({
      orderScores: EMPTY_DEEP_HEAD_SCORES,
      coverageRelevance: EMPTY_DEEP_HEAD_SCORES,
      coverageRelevanceUpperBound: null
    });
  }
  return Object.freeze({
    orderScores: embeddingScores,
    coverageRelevance: embeddingScores,
    coverageRelevanceUpperBound: createRecallRelevanceUpperBoundReceipt(
      INDEPENDENT_EMBEDDING_DELIVERY_OPERATOR_ID,
      embeddingScores
    )
  });
}

export type DeepHeadAssessmentResolver = (
  input: Readonly<{
    readonly candidates: readonly DeliverySelectionCandidate[];
    readonly answerRelevanceScores: ReadonlyMap<string, number>;
    readonly supplementaryData: Parameters<
      typeof resolveDeepHeadAssessment
    >[0]["supplementaryData"];
    readonly includeTraces?: boolean;
  }>
) => RecallDeepHeadAssessment;

/** Resolve deep-head via injected assessment; skip trace materialization off capture. */
export function resolveFineAssessmentDeepHead(
  input: Readonly<{
    readonly candidates: readonly DeliverySelectionCandidate[];
    readonly answerRelevanceScores: ReadonlyMap<string, number>;
    readonly supplementaryData: Parameters<
      typeof resolveDeepHeadAssessment
    >[0]["supplementaryData"];
    readonly captureAnswerFeatures?: boolean;
  }>,
  resolveAssessment: DeepHeadAssessmentResolver = resolveDeepHeadAssessment
): RecallDeepHeadAssessment {
  return resolveAssessment({
    candidates: input.candidates,
    answerRelevanceScores: input.answerRelevanceScores,
    supplementaryData: input.supplementaryData,
    includeTraces: input.captureAnswerFeatures === true
  });
}
