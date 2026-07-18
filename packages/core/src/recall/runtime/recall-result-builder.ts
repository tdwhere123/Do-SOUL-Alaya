import { buildRecallDiagnostics, computeRecallTokenEconomy } from "./diagnostics.js";
import { buildRecallCandidateDedupeKey } from "./recall-service-helpers.js";
import type { CoarseStageResult } from "./recall-service-runner-coarse.js";
import type {
  PreparedRecallRequest,
  RecallAssessmentStageResult,
  RecallManifestedResult
} from "./recall-service-runner-types.js";
import type {
  CoarseRecallCandidate,
  FineAssessmentPrunedCandidateDiagnostic,
  RecallDegradationReason,
  RecallResult,
  RecallTokenEconomy
} from "./recall-service-types.js";

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
      embeddingSupplementStatus: assessment.embeddingSupplementStatus,
      providerDegradationReason: assessment.providerDegradationReason,
      answerRerankDiagnostics: assessment.answerRerankDiagnostics,
      degradationReasons: [...degradationReasons],
      graphExpansionDiagnostics: coarse.coarseFilter.graphExpansionDiagnostics,
      candidates: manifested.candidateDiagnostics,
      fineAssessmentPrunedCandidates: buildFineAssessmentPrunedDiagnostics(
        coarse.combinedCoarseCandidates,
        assessment.finalAssessment.prunedCandidates
      ),
      tokenEconomy,
      embeddingWorkspaceScan: assessment.embeddingCoarseInjection.workspaceScan,
      phaseLatencyMs
    })
  });
}

function buildFineAssessmentPrunedDiagnostics(
  coarseCandidates: readonly Readonly<CoarseRecallCandidate>[],
  prunedCandidates: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<FineAssessmentPrunedCandidateDiagnostic>[] {
  const indexByKey = new Map(coarseCandidates.map((candidate, index) => [
    buildRecallCandidateDedupeKey(candidate), index
  ] as const));
  return Object.freeze(prunedCandidates.map((candidate) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const coarseIndex = indexByKey.get(candidateKey);
    if (coarseIndex === undefined) {
      throw new Error(`fine-assessment pruned candidate missing from coarse pool: ${candidateKey}`);
    }
    return Object.freeze({
      candidate_key: candidateKey,
      origin_plane: candidate.originPlane ?? "workspace_local",
      object_kind: candidate.objectKind ?? "memory_entry",
      object_id: candidate.entry.object_id,
      coarse_index: coarseIndex,
      drop_reason: "fine_assessment_cap" as const
    });
  }));
}

function buildPhaseLatencyMs(
  coarse: CoarseStageResult,
  assessment: RecallAssessmentStageResult,
  manifested: RecallManifestedResult
): Readonly<Record<string, number>> {
  return Object.freeze({
    coarse: coarse.recallAfterCoarse - coarse.recallPhaseStart,
    synthesis: coarse.recallAfterSynthesis - coarse.recallAfterCoarse,
    embedding:
      coarse.recallAfterEmbedding - coarse.recallAfterSynthesis +
      assessment.phaseLatencyMs.embedding,
    assessment: assessment.phaseLatencyMs.assessment,
    cross_rerank: assessment.phaseLatencyMs.cross_rerank,
    delivery: assessment.phaseLatencyMs.delivery,
    manifestation: manifested.manifestationLatencyMs
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
    // Waist survivors actually scored in fine assessment — not the pre-prune coarse pool.
    fineEvaluated: assessment.finalAssessment.fineEvaluated,
    finePrunedCount: assessment.finalAssessment.finePrunedCount,
    finePriorityOverflowCount: assessment.finalAssessment.finePriorityOverflowCount,
    preBudgetCandidates: manifested.candidateDiagnostics,
    embeddingInferenceCalls:
      assessment.embeddingCoarseInjection.embeddingInferenceCalls + preparedEmbeddingInferenceCalls
  });
}
