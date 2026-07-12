import { buildRecallDiagnostics, computeRecallTokenEconomy } from "./diagnostics.js";
import type { CoarseStageResult } from "./recall-service-runner-coarse.js";
import type {
  PreparedRecallRequest,
  RecallAssessmentStageResult,
  RecallManifestedResult
} from "./recall-service-runner-types.js";
import type { RecallDegradationReason, RecallResult, RecallTokenEconomy } from "./recall-service-types.js";

export function buildRecallResult(
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: RecallAssessmentStageResult,
  manifested: RecallManifestedResult,
  degradationReasons: ReadonlySet<RecallDegradationReason>
): RecallResult {
  const phaseLatencyMs = buildPhaseLatencyMs(coarse, assessment, manifested);
  const tokenEconomy = buildTokenEconomy(assessment, coarse.combinedCoarseCandidates.length, manifested);
  return Object.freeze({
    candidates: manifested.candidates,
    active_constraints: prepared.activeConstraints.constraints,
    active_constraints_count: prepared.activeConstraints.total_count,
    total_scanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
    coarse_filter_count: coarse.combinedCoarseCandidates.length,
    fine_assessment_count: manifested.candidates.length,
    degradation_reason: coarse.coarseFilter.degradation_reason,
    working_projection: null,
    diagnostics: buildRecallDiagnostics({
      queryProbes: prepared.queryProbes,
      querySoughtFacets: assessment.supplementaryData.querySoughtFacets,
      totalScanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
      candidatePoolCount: coarse.combinedCoarseCandidates.length,
      preBudgetCount: manifested.candidateDiagnostics.length,
      deliveredCount: manifested.candidates.length,
      embeddingProviderStatus: assessment.embeddingProviderStatus,
      providerDegradationReason: assessment.providerDegradationReason,
      degradationReasons: [...degradationReasons],
      graphExpansionDiagnostics: coarse.coarseFilter.graphExpansionDiagnostics,
      candidates: manifested.candidateDiagnostics,
      tokenEconomy,
      embeddingWorkspaceScan: assessment.embeddingCoarseInjection.workspaceScan,
      phaseLatencyMs
    })
  });
}

function buildPhaseLatencyMs(
  coarse: CoarseStageResult,
  assessment: RecallAssessmentStageResult,
  manifested: RecallManifestedResult
): Readonly<Record<string, number>> {
  return Object.freeze({
    coarse: coarse.recallAfterCoarse - coarse.recallPhaseStart,
    synthesis: coarse.recallAfterSynthesis - coarse.recallAfterCoarse,
    fusion: assessment.recallAfterFusion - coarse.recallAfterSynthesis,
    manifestation: manifested.recallAfterManifestation - assessment.recallAfterFusion
  });
}

function buildTokenEconomy(
  assessment: RecallAssessmentStageResult,
  coarsePoolSize: number,
  manifested: RecallManifestedResult
): Readonly<RecallTokenEconomy> {
  const preparedEmbeddingInferenceCalls =
    assessment.embeddingProviderStatus === "provider_returned" &&
    assessment.preparedEmbeddingQuery.handle?.cacheHit === false
      ? 1
      : 0;
  return computeRecallTokenEconomy({
    deliveredCandidates: manifested.candidates,
    coarsePoolSize,
    fineEvaluated: coarsePoolSize,
    preBudgetCandidates: manifested.candidateDiagnostics,
    embeddingInferenceCalls:
      assessment.embeddingCoarseInjection.embeddingInferenceCalls + preparedEmbeddingInferenceCalls
  });
}
