import type {
  RecallCandidate,
  RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  buildRecallBudgetState,
  buildRecallCandidateSelectionKey
} from "../../runtime/recall-candidate-builder.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import type {
  RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import {
  retainBoundedAnswerHeads,
  type DirectEvidenceHeadSelection
} from "../admission/direct-evidence-answer-head.js";
import { orderWithEmbeddingEvidenceDominance } from
  "./embedding-evidence-dominance-order.js";
import { orderByFinalAuthority } from "./final-authority-order.js";

type FinalPacketSourceCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveFactors: Readonly<{
    readonly embedding_similarity?: number;
  }>;
  readonly fusion: RecallFusionBreakdown;
}>;

export type FinalPacketOrderMode = "public_relevance" | "delivery_rank";

export type FinalPacketOrderContext = Readonly<{
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: Pick<RecallSupplementaryData, "queryProbes">;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
}>;

export function orderDeliveredPacket<T extends FinalPacketSourceCandidate>(
  params: Readonly<{
    readonly selected: readonly RecallCandidate[];
    readonly diagnostics: readonly RecallCandidateDiagnostic[];
    readonly context: FinalPacketOrderContext;
    readonly finalOrder: FinalPacketOrderMode;
    readonly maxHeadDrop: number | undefined;
    readonly answerHeadProtections: DirectEvidenceHeadSelection<T>["protections"];
    readonly sourceCandidates: readonly T[];
  }>
): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const verifiedOrder = orderByFinalAuthority({
    candidates: params.selected,
    finalOrder: params.finalOrder,
    deliveryRankByCandidateKey: params.context.rankByCandidateKey,
    maxHeadDrop: params.maxHeadDrop,
    protectedRankLimit: params.context.config.budgets.max_entries,
    answerSupportByCandidateKey: params.context.answerSupportByCandidateKey
  });
  const ordered = orderWithAnswerHeadProtections(verifiedOrder, params);
  return materializeFinalPacket(
    ordered,
    params.diagnostics,
    params.context.config.budgets
  );
}

export function materializeFinalPacket(
  candidates: readonly Readonly<RecallCandidate>[],
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  budgets: Readonly<RecallPolicy>["fine_assessment"]["budgets"]
): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  let usedTokens = 0;
  const finalRankByKey = new Map<string, number>();
  const ranked = candidates.map((candidate, index) => {
    finalRankByKey.set(buildRecallCandidateSelectionKey(candidate), index + 1);
    const budgetState = buildRecallBudgetState({
      tokenEstimate: candidate.token_estimate,
      maxEntries: budgets.max_entries,
      maxTotalTokens: budgets.max_total_tokens,
      index,
      usedTokensBeforeCandidate: usedTokens
    });
    usedTokens += candidate.token_estimate;
    return Object.freeze({ ...candidate, budget_state: budgetState });
  });
  return Object.freeze({
    candidates: Object.freeze(ranked),
    diagnostics: updateFinalRanks(diagnostics, finalRankByKey)
  });
}

function orderWithAnswerHeadProtections<T extends FinalPacketSourceCandidate>(
  candidates: readonly Readonly<RecallCandidate>[],
  params: Readonly<{
    readonly context: FinalPacketOrderContext;
    readonly finalOrder: FinalPacketOrderMode;
    readonly maxHeadDrop: number | undefined;
    readonly answerHeadProtections: DirectEvidenceHeadSelection<T>["protections"];
    readonly sourceCandidates: readonly T[];
  }>
): readonly Readonly<RecallCandidate>[] {
  const retain = (ordered: readonly Readonly<RecallCandidate>[]) =>
    retainBoundedAnswerHeads(
      ordered,
      params.answerHeadProtections,
      buildRecallCandidateSelectionKey,
      params.context.supplementaryData.queryProbes,
      params.sourceCandidates
    );
  const applyDominance = (ordered: readonly Readonly<RecallCandidate>[]) =>
    params.finalOrder === "public_relevance" && params.maxHeadDrop === undefined
      ? orderWithEmbeddingEvidenceDominance({
          candidates: ordered,
          sourceCandidates: params.sourceCandidates,
          queryProbes: params.context.supplementaryData.queryProbes,
          answerSupportByCandidateKey: params.context.answerSupportByCandidateKey,
          keyOf: buildRecallCandidateSelectionKey
        })
      : ordered;
  return params.answerHeadProtections.some((item) => item.rankLimit === 1)
    ? retain(applyDominance(candidates))
    : applyDominance(retain(candidates));
}

function updateFinalRanks(
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  finalRankByKey: ReadonlyMap<string, number>
): readonly Readonly<RecallCandidateDiagnostic>[] {
  return Object.freeze(diagnostics.map((row) => {
    const finalRank = finalRankByKey.get(row.candidate_key) ?? null;
    return Object.freeze({ ...row, final_rank: finalRank, post_rank: finalRank });
  }));
}
