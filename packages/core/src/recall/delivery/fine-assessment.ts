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
  type FineAssessmentCandidate,
  type FineAssessmentRankDiagnostics
} from "./fine-assessment-selection.js";

export interface FineAssessParams {
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly now: () => string;
  readonly warn: RecallServiceWarnPort;
}

export function fineAssess(params: FineAssessParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  if (params.candidates.length === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      diagnostics: Object.freeze([])
    });
  }
  const config = params.policy.fine_assessment;
  const scoredCandidates = scoreFineAssessmentCandidates(params);
  const fusedCandidates = fuseFineAssessmentCandidates(
    scoredCandidates,
    params.policy,
    params.supplementaryData,
    params.now()
  );
  const delivery = applyDeliverySelection(
    fusedCandidates,
    params.supplementaryData,
    config.budgets.max_entries
  );
  return selectFineAssessmentCandidates({
    deliveryOrderedCandidates: delivery.ordering.deliveryOrderedCandidates,
    config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    ranks: toFineAssessmentRankDiagnostics(delivery.ranks)
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
  return additiveScoredCandidates.map((candidate) => Object.freeze({
    ...candidate,
    fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
  }));
}

function toFineAssessmentRankDiagnostics(
  ranks: ReturnType<typeof applyDeliverySelection>["ranks"]
): FineAssessmentRankDiagnostics {
  return Object.freeze({
    rankAfterFusion: ranks.rankAfterFusion,
    rankAfterFeatureRerank: ranks.rankAfterFeatureRerank,
    rankAfterLexicalPriority: ranks.rankAfterLexicalPriority,
    rankAfterCoverageSelector: ranks.rankAfterCoverageSelector,
    rankAfterSessionCoverage: ranks.rankAfterSessionCoverage,
    rankAfterSynthesisReserve: ranks.rankAfterSynthesisReserve,
    rankAfterStructuralReserve: ranks.rankAfterStructuralReserve,
    coverageSelectorNoop: ranks.coverageSelectorNoop,
    sessionCoverageNoop: ranks.sessionCoverageNoop
  });
}
