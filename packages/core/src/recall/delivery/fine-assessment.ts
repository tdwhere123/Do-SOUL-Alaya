import type {
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "../runtime/recall-service-types.js";
import {
  applyPathSuppressionToFusionScores,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails
} from "./fusion-delivery.js";
import { applyDeliverySelection } from "./delivery-selection.js";
import { computeEffectiveScoreDetails } from "../scoring/scoring.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "./fine-assessment-selection.js";
import {
  pruneCoarseCandidatesForFineAssessment,
  type FineAssessmentPruneResult
} from "./fine-assessment-prune.js";
import { resolveDeepHeadScores } from "../rerank/deep-head.js";

export interface FineAssessParams {
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly now: () => string;
  readonly warn: RecallServiceWarnPort;
  readonly captureAnswerFeatures?: boolean;
}

export type FineAssessmentPreparation = Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
}>;

export function fineAssess(params: FineAssessParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly preparedCandidates: readonly FineAssessmentCandidate[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
}> {
  return deliverFineAssessment(params, prepareFineAssessment(params));
}

export function prepareFineAssessment(
  params: FineAssessParams
): FineAssessmentPreparation {
  if (params.candidates.length === 0) {
    return emptyFineAssessmentPreparation();
  }
  const pruned = pruneCoarseCandidatesForFineAssessment({
    candidates: params.candidates,
    supplementaryData: params.supplementaryData,
    winnerMemoryIds: params.winnerMemoryIds
  });
  const scoredCandidates = scoreFineAssessmentCandidates({
    ...params,
    candidates: pruned.survivors
  });
  const fusedCandidates = fuseFineAssessmentCandidates(
    scoredCandidates,
    params.policy,
    params.supplementaryData,
    params.now()
  );
  return preparationFromPrune(pruned, fusedCandidates);
}

export function deliverFineAssessment(
  params: FineAssessParams,
  preparation: FineAssessmentPreparation
): ReturnType<typeof fineAssess> {
  const answerRelevanceScores =
    params.supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  // CE present → scores own public relevance. Lightweight head reorders only so
  // fused_score / 8-factor governance stay visible on RecallCandidate.
  const replacePublicRelevance = answerRelevanceScores.size > 0;
  const deepHeadScores = resolveDeepHeadScores({
    candidates: preparation.candidates,
    answerRelevanceScores,
    supplementaryData: params.supplementaryData
  });
  const delivery = applyDeliverySelection(preparation.candidates, deepHeadScores, {
    replacePublicRelevance
  });
  const selected = selectFineAssessmentCandidates({
    orderedCandidates: delivery.orderedCandidates,
    config: params.policy.fine_assessment,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: delivery.rankByCandidateKey,
    finalRelevanceByCandidateKey: delivery.finalRelevanceByCandidateKey,
    // Pack by deep-head scores even when public relevance stays fused — otherwise
    // coverage undoes the lightweight reorder by re-ranking on fused_score.
    coverageRelevanceByCandidateKey: deepHeadScores,
    answerRelevanceRankByCandidateKey: delivery.answerRelevanceRankByCandidateKey,
    captureAnswerFeatures: params.captureAnswerFeatures
  });
  return Object.freeze({
    ...selected,
    preparedCandidates: preparation.candidates,
    coarsePoolSize: preparation.coarsePoolSize,
    fineEvaluated: preparation.fineEvaluated,
    finePrunedCount: preparation.finePrunedCount
  });
}

type AdditiveScoredCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;

function scoreFineAssessmentCandidates(params: FineAssessParams): readonly AdditiveScoredCandidate[] {
  return params.candidates.map((candidate) => {
    const scored = computeEffectiveScoreDetails({
      entry: candidate.entry,
      policy: params.policy,
      winnerMemoryIds: params.winnerMemoryIds,
      supplementaryData: params.supplementaryData,
      originPlane: candidate.originPlane ?? "workspace_local",
      isAdvisory: candidate.isAdvisory ?? false,
      scoreMultiplier: candidate.scoreMultiplier ?? 1,
      objectKind: candidate.objectKind ?? "memory_entry",
      now: params.now,
      warn: params.warn
    });
    return Object.freeze({ ...candidate, effectiveScore: scored.score, effectiveFactors: scored.factors });
  });
}

function fuseFineAssessmentCandidates(
  additiveScoredCandidates: readonly AdditiveScoredCandidate[],
  policy: Readonly<RecallPolicy>,
  supplementaryData: RecallSupplementaryData,
  nowIso: string
): readonly FineAssessmentCandidate[] {
  const fusionByCandidateKey = applyPathSuppressionToFusionScores(
    buildRecallFusionDetails({ candidates: additiveScoredCandidates, policy, supplementaryData, nowIso }),
    supplementaryData.pathSuppressionScores
  );
  const fusedCandidates = additiveScoredCandidates.map((candidate) => Object.freeze({
    ...candidate,
    fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
  }));
  return fusedCandidates;
}

function emptyFineAssessmentPreparation(): FineAssessmentPreparation {
  return Object.freeze({
    candidates: Object.freeze([]),
    coarsePoolSize: 0,
    fineEvaluated: 0,
    finePrunedCount: 0
  });
}

function preparationFromPrune(
  pruned: FineAssessmentPruneResult,
  candidates: readonly FineAssessmentCandidate[]
): FineAssessmentPreparation {
  return Object.freeze({
    candidates,
    coarsePoolSize: pruned.coarsePoolSize,
    fineEvaluated: pruned.fineEvaluated,
    finePrunedCount: pruned.finePrunedCount
  });
}
