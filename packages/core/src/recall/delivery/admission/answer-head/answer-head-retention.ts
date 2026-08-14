import type { CoarseRecallCandidate, RecallFusionBreakdown } from
  "../../../runtime/recall-service-types.js";

export type AnswerHeadSourceCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveFactors: Readonly<{ readonly embedding_similarity?: number }>;
  readonly fusion: RecallFusionBreakdown;
}>;
