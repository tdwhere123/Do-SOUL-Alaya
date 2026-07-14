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

export function fineAssess(params: FineAssessParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly preparedCandidates: readonly FineAssessmentCandidate[];
}> {
  return deliverFineAssessment(params, prepareFineAssessment(params));
}

export function prepareFineAssessment(
  params: FineAssessParams
): readonly FineAssessmentCandidate[] {
  if (params.candidates.length === 0) {
    return Object.freeze([]);
  }
  const scoredCandidates = scoreFineAssessmentCandidates(params);
  return fuseFineAssessmentCandidates(
    scoredCandidates,
    params.policy,
    params.supplementaryData,
    params.now()
  );
}

export function deliverFineAssessment(
  params: FineAssessParams,
  preparedCandidates: readonly FineAssessmentCandidate[]
): ReturnType<typeof fineAssess> {
  const delivery = applyDeliverySelection(
    preparedCandidates,
    params.supplementaryData.answerRelevanceScoresByCandidateKey
  );
  const selected = selectFineAssessmentCandidates({
    orderedCandidates: delivery.orderedCandidates,
    config: params.policy.fine_assessment,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: delivery.rankByCandidateKey,
    finalRelevanceByCandidateKey: delivery.finalRelevanceByCandidateKey,
    answerRelevanceRankByCandidateKey: delivery.answerRelevanceRankByCandidateKey,
    captureAnswerFeatures: params.captureAnswerFeatures
  });
  return Object.freeze({ ...selected, preparedCandidates });
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
