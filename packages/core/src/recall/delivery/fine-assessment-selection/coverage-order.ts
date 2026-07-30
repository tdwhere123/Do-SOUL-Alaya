import { orderByCoverageMarginalGain } from "../coverage-selection.js";
import { hasRankedEmbeddingHead, selectEmbeddingHeadEvictions } from
  "../admission/embedding-head-dominance.js";
import { buildFineAssessmentAnswerSupportContext } from
  "../answer-support/answer-support-context.js";
import {
  collectAdmittedCandidates,
  createAdmissionState,
  tryRecordAcceptedAdmission
} from "./admission.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "./types.js";

export function createSelectionContext(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionContext {
  const answerRelevanceRankByCandidateKey =
    params.answerRelevanceRankByCandidateKey ?? new Map();
  const captureAnswerFeatures = params.captureAnswerFeatures ?? false;
  const answerSupport = buildFineAssessmentAnswerSupportContext({
    candidates: params.orderedCandidates,
    supplementaryData: params.supplementaryData,
    captureObservations: captureAnswerFeatures
  });
  return Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    finalRelevanceByCandidateKey: params.finalRelevanceByCandidateKey ?? new Map(),
    answerRelevanceRankByCandidateKey,
    answerRerankedCandidateKeys: new Set(answerRelevanceRankByCandidateKey.keys()),
    captureAnswerFeatures,
    answerSupportByCandidateKey: answerSupport.supportByCandidateKey,
    answerSupportObservationsByCandidateKey:
      answerSupport.observationsByCandidateKey,
    deepHeadTraceByCandidateKey: captureAnswerFeatures
      ? params.deepHeadTraceByCandidateKey ?? new Map()
      : new Map(),
    coverageMarginalGainByCandidateKey: new Map(),
    tokenEstimateByCandidateKey: new Map()
  });
}

export function prepareCoverageSelection(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): Readonly<{
  readonly coverageOrdered: readonly FineAssessmentCandidate[];
  readonly evictions: ReadonlySet<string>;
}> {
  const coverageRelevance =
    params.coverageRelevanceByCandidateKey ?? context.finalRelevanceByCandidateKey;
  const hasEmbeddingHead = hasRankedEmbeddingHead(
    params.orderedCandidates,
    context.config.budgets.max_entries
  );
  const captureMarginalGain = context.captureAnswerFeatures;
  const initialOrder = orderFineAssessmentByCoverage(
    params.orderedCandidates, context, coverageRelevance, new Set<string>(),
    !hasEmbeddingHead && captureMarginalGain
  );
  if (!hasEmbeddingHead) {
    return Object.freeze({ coverageOrdered: initialOrder, evictions: new Set<string>() });
  }
  const resolved = resolveEmbeddingHeadEvictions(
    initialOrder,
    context,
    coverageRelevance,
    captureMarginalGain
  );
  const evictions = resolved.evictions;
  const coverageOrdered = evictions.size > 0
    ? resolved.coverageOrdered
    : captureMarginalGain
      ? orderFineAssessmentByCoverage(
          initialOrder, context, coverageRelevance, new Set<string>(), true
        )
      : initialOrder;
  return Object.freeze({
    coverageOrdered,
    evictions
  });
}

function orderFineAssessmentByCoverage(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  evictions: ReadonlySet<string>,
  captureMarginalGain = false
): readonly FineAssessmentCandidate[] {
  const admission = createAdmissionState();
  return orderByCoverageMarginalGain({
    candidates,
    relevanceByCandidateKey,
    supplementaryData: context.supplementaryData,
    advancesCoverage: (candidate) => tryRecordAcceptedAdmission(
      admission,
      candidate,
      context,
      evictions
    ),
    onSelection: captureMarginalGain
      ? (observation) => context.coverageMarginalGainByCandidateKey.set(
          observation.candidate_key,
          observation.marginal_gain
        )
      : undefined
  });
}

function resolveEmbeddingHeadEvictions(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  captureMarginalGain: boolean
): Readonly<{
  readonly evictions: ReadonlySet<string>;
  readonly coverageOrdered: readonly FineAssessmentCandidate[];
}> {
  let coverageOrdered = candidates;
  const evictions = selectEmbeddingHeadEvictions({
    candidates,
    maxEntries: context.config.budgets.max_entries,
    embeddingScores: context.supplementaryData.embeddingSimilarityScores,
    queryProbes: context.supplementaryData.queryProbes,
    answerRerankedCandidateKeys: context.answerRerankedCandidateKeys,
    selectDelivered: (evictionSet) => {
      coverageOrdered = orderFineAssessmentByCoverage(
        candidates,
        context,
        relevanceByCandidateKey,
        evictionSet,
        captureMarginalGain
      );
      return collectAdmittedCandidates(
        coverageOrdered,
        context,
        evictionSet
      );
    }
  });
  coverageOrdered = orderFineAssessmentByCoverage(
    candidates,
    context,
    relevanceByCandidateKey,
    evictions,
    captureMarginalGain
  );
  return Object.freeze({ evictions, coverageOrdered });
}
