import type {
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallCandidateDedupeKey,
  isSynthesisChildCandidate
} from "../runtime/recall-service-helpers.js";
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
import { resolveFineAssessmentDeliveryBranch } from
  "./fine-assessment-delivery-branch.js";
import { resolveFineAssessmentDeepHead, composeFineAssessmentDeepHeadDelivery } from
  "./fine-assessment-deep-head.js";
import { computeEffectiveScoreDetails } from "../scoring/scoring.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "./fine-assessment-selection.js";
import type { RecallPacketPlanObservation } from
  "./packet-plan/packet-plan-observation.js";
import type { FineAssessmentSelectionBoundaryPendingCapture } from
  "./selection-boundary/selection-boundary-capture.js";
import type { CoverageSelectionObjectiveReceipt } from
  "./coverage-selection.js";
import type { RecallFieldRefinementStopCertificate } from
  "../field/refinement/field-refinement-stop-certificate.js";
import type { RecallAnswerShapePlan } from
  "../query/recall-answer-shape-plan.js";

export interface FineAssessParams {
  readonly workspace_id: string;
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly now: () => string;
  readonly warn: RecallServiceWarnPort;
  readonly captureAnswerFeatures?: boolean;
  readonly capturePacketPlanTrace?: boolean;
  readonly answerShapePlan?: Readonly<RecallAnswerShapePlan>;
  readonly selectionBoundaryObserver?: (
    boundary: FineAssessmentSelectionBoundaryPendingCapture
  ) => undefined;
  readonly generation_id?: string;
  readonly condition_digest?: string;
}

export type FineAssessmentPreparation = Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly prunedCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
  readonly finePriorityOverflowCount: number;
}>;

export function fineAssess(params: FineAssessParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly coverageSelectionObjective: CoverageSelectionObjectiveReceipt;
  readonly fieldRefinementStopCertificate?:
    Readonly<RecallFieldRefinementStopCertificate>;
  readonly packetPlanObservation?: Readonly<RecallPacketPlanObservation>;
  readonly preparedCandidates: readonly FineAssessmentCandidate[];
  readonly prunedCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly coarsePoolSize: number;
  readonly fineEvaluated: number;
  readonly finePrunedCount: number;
  readonly finePriorityOverflowCount: number;
}> {
  return deliverFineAssessment(params, prepareFineAssessment(params));
}

export function prepareFineAssessment(
  params: FineAssessParams
): FineAssessmentPreparation {
  assertUniqueCandidateField(params.candidates);
  const scoredCandidates = scoreFineAssessmentCandidates(params);
  const fusedCandidates = fuseFineAssessmentCandidates(
    scoredCandidates,
    params.policy,
    params.supplementaryData,
    params.now()
  );
  return preparationFromCompleteField(params.candidates, fusedCandidates);
}

function assertUniqueCandidateField(
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): void {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (keys.has(key)) {
      throw new Error(`duplicate recall candidate field key: ${key}`);
    }
    keys.add(key);
  }
}

export function deliverFineAssessment(
  params: FineAssessParams,
  preparation: FineAssessmentPreparation
): ReturnType<typeof fineAssess> {
  const answerRelevanceScores =
    params.supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  const deepHead = resolveFineAssessmentDeepHead({
    candidates: preparation.candidates,
    answerRelevanceScores,
    supplementaryData: params.supplementaryData,
    captureAnswerFeatures: params.captureAnswerFeatures
  });
  const composed = composeFineAssessmentDeepHeadDelivery(deepHead);
  const branch = resolveFineAssessmentDeliveryBranch({
    answerRelevanceScores
  });
  const delivery = applyDeliverySelection(preparation.candidates, composed.orderScores, {
    replacePublicRelevance: branch.replacePublicRelevance
  });
  const selected = selectFineAssessmentCandidates({
    workspace_id: params.workspace_id,
    orderedCandidates: delivery.orderedCandidates,
    packetCandidates: preparation.candidates,
    generation_id: params.generation_id,
    condition_digest: params.condition_digest,
    config: params.policy.fine_assessment,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: delivery.rankByCandidateKey,
    finalRelevanceByCandidateKey: delivery.finalRelevanceByCandidateKey,
    coverageRelevanceByCandidateKey: composed.coverageRelevance,
    coverageRelevanceUpperBound: composed.coverageRelevanceUpperBound,
    answerRelevanceRankByCandidateKey: delivery.answerRelevanceRankByCandidateKey,
    captureAnswerFeatures: params.captureAnswerFeatures,
    answerShapePlan: params.answerShapePlan,
    capturePacketPlanTrace: params.capturePacketPlanTrace,
    deepHeadTraceByCandidateKey: deepHead.traceByCandidateKey,
    selectionBoundaryObserver: params.selectionBoundaryObserver
  });
  return Object.freeze({
    ...selected,
    preparedCandidates: preparation.candidates,
    prunedCandidates: preparation.prunedCandidates,
    coarsePoolSize: preparation.coarsePoolSize,
    fineEvaluated: preparation.fineEvaluated,
    finePrunedCount: preparation.finePrunedCount,
    finePriorityOverflowCount: preparation.finePriorityOverflowCount
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
      synthesisChild: isSynthesisChildCandidate(candidate),
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

function preparationFromCompleteField(
  field: readonly Readonly<CoarseRecallCandidate>[],
  candidates: readonly FineAssessmentCandidate[]
): FineAssessmentPreparation {
  return Object.freeze({
    candidates,
    prunedCandidates: Object.freeze([]),
    coarsePoolSize: field.length,
    fineEvaluated: field.length,
    finePrunedCount: 0,
    finePriorityOverflowCount: 0
  });
}
