import { withEmbeddingSimilarityScores } from
  "../../coarse-filter/embedding/embedding-similarity-supplement.js";
import {
  deliverFineAssessment,
  prepareFineAssessment,
  type FineAssessParams
} from "../../delivery/fine-assessment.js";
import type { CoarseStageResult } from "../recall-service-runner-coarse.js";
import {
  capturesRecallAnswerFeatures,
  type FineAssessmentPreparation,
  type FineAssessmentResult,
  type PreparedRecallRequest,
  type RecallExecutionContext,
  type RecallExecutionParams
} from "../recall-service-runner-types.js";
import { collectCoarseFilterSupplementaryData } from "./coarse.js";
import type { EmbeddingAssessmentData } from "./recall-embedding-assessment.js";
import { attributeEvidenceSemanticActivations } from
  "./evidence-semantic-candidates.js";
import { attributeOpenSemanticFactorActivations } from
  "../../field/open-semantic-factors/candidate-attribution.js";
import {
  measureAsync,
  measureSync,
  type TimedResult
} from "./recall-phase-latency.js";

export type CollectedFineAssessmentData = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
}>;

type RerankResult = Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly applied: boolean;
}>;

export function collectTimedSupplementaryData(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<TimedResult<CollectedFineAssessmentData>> {
  return measureAsync(async () => {
    const supplementaryData = await collectCoarseFilterSupplementaryData(
      buildCoarseAssessmentParams(
        context,
        params,
        prepared,
        coarse,
        coarse.combinedCoarseCandidates
      )
    );
    return Object.freeze({
      supplementaryData: Object.freeze({
        ...supplementaryData,
        openSemanticFactorCandidateActivationsByCandidateKey:
          supplementaryData.openSemanticFactorActivation === undefined
            ? new Map()
            : attributeOpenSemanticFactorActivations({
              candidates: coarse.combinedCoarseCandidates,
              activation: supplementaryData.openSemanticFactorActivation
            })
      })
    });
  });
}

export function prepareSnapshotAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  base: CollectedFineAssessmentData,
  embeddingData: EmbeddingAssessmentData
): Readonly<{
  readonly preparedCandidates: FineAssessmentPreparation;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
}> {
  const supplementaryData = withEmbeddingSimilarityScores(
    base.supplementaryData,
    embeddingData.supplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    embeddingData.poolRescoreScores,
    attributedEvidenceActivations(base.supplementaryData, embeddingData),
    embeddingData.retrievalFieldSeal,
    embeddingData.retrievalFieldRefinementReceipts
  );
  return Object.freeze({
    supplementaryData,
    preparedCandidates: prepareFineAssessment(buildFineAssessParams(
      context,
      params,
      prepared,
      supplementaryData,
      coarse.combinedCoarseCandidates
    ))
  });
}

function attributedEvidenceActivations(
  supplementaryData: FineAssessParams["supplementaryData"],
  embeddingData: EmbeddingAssessmentData
) {
  const activations = embeddingData.evidenceScoring.activationsByCandidateKey;
  if (activations.size === 0) return new Map();
  return attributeEvidenceSemanticActivations({
    activations,
    evidenceDocumentsByMemoryId:
      supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {}
  });
}

export function deliverOrReuseAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  preparedCandidates: FineAssessmentPreparation,
  rerank: RerankResult
): TimedResult<FineAssessmentResult> {
  return measureSync(() => deliverFineAssessment(
    buildFineAssessParams(
      context, params, prepared, rerank.supplementaryData, preparedCandidates.candidates
    ),
    preparedCandidates
  ));
}

function buildFineAssessParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  supplementaryData: FineAssessParams["supplementaryData"],
  candidates: FineAssessParams["candidates"]
): FineAssessParams {
  return {
    workspace_id: params.workspaceId,
    candidates,
    policy: prepared.policy,
    winnerMemoryIds: prepared.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: prepared.tokenEstimator,
    now: () => prepared.referenceTime,
    warn: context.warn,
    captureAnswerFeatures: capturesRecallAnswerFeatures(params.diagnosticCapture),
    capturePacketPlanTrace: params.diagnosticCapture === "packet_trace",
    answerShapePlan: prepared.answerShapePlan,
    selectionBoundaryObserver: params.selectionBoundaryObserver,
    generation_id: prepared.queryCondition.generation_id,
    condition_digest: prepared.queryCondition.identity
  };
}

function buildCoarseAssessmentParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  candidates: FineAssessParams["candidates"]
): Parameters<typeof collectCoarseFilterSupplementaryData>[0] {
  return {
    dependencies: context.dependencies,
    warn: context.warn,
    referenceTime: prepared.referenceTime,
    coarseFilter: Object.freeze({ ...coarse.coarseFilter, candidates }),
    workspaceId: params.workspaceId,
    pathProjectionAsOf: prepared.temporalProjectionAsOf,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    policy: prepared.policy,
    queryProbes: prepared.queryProbes,
    queryEntityExtraction: prepared.queryEntityExtraction,
    querySemanticFactorFormationProposal:
      params.querySemanticFactorFormationProposal,
    querySemanticFactorFormationCapture:
      params.querySemanticFactorFormationCapture,
    winnerMemoryIds: prepared.winnerMemoryIds,
    tokenEstimator: prepared.tokenEstimator,
    captureAnswerFeatures: capturesRecallAnswerFeatures(params.diagnosticCapture),
    degradationReasons: context.degradationReasons
  };
}
