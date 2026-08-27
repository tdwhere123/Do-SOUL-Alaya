import {
  buildRecallDiagnostics,
  computeRecallTokenEconomy,
  EMPTY_FINE_ASSESSMENT_PRUNED_DIAGNOSTICS,
  EMPTY_RECALL_CANDIDATE_DIAGNOSTICS
} from "./diagnostics.js";
import { queryConditionParityView } from "./query-condition-parity.js";
import { buildRecallCandidateDedupeKey } from "./recall-service-helpers.js";
import { buildCaptureProofDiagnostics } from
  "./diagnostics/capture-proof-diagnostics.js";
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
import type { SelectGammaSynthesisStatus } from
  "../delivery/select-gamma/synthesis-adapter.js";

type RecallExecutionPhaseLatencyMs = Readonly<{
  readonly preparation: number;
  readonly select_gamma_synthesis: number;
  readonly result_build: number;
  readonly side_effects: number;
}>;

export function buildRecallResult(
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: RecallAssessmentStageResult,
  manifested: RecallManifestedResult,
  degradationReasons: ReadonlySet<RecallDegradationReason>,
  synthesis: SelectGammaSynthesisStatus,
  includeCandidateEvidence: boolean
): RecallResult {
  const phaseLatencyMs = buildPhaseLatencyMs(coarse, assessment, manifested);
  const tokenEconomy = buildTokenEconomy(
    assessment,
    coarse.combinedCoarseCandidates.length,
    manifested,
    includeCandidateEvidence
  );
  return Object.freeze({
    candidates: manifested.candidates,
    synthesis,
    active_constraints: prepared.activeConstraints.constraints,
    active_constraints_count: prepared.activeConstraints.total_count,
    total_scanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
    coarse_filter_count: coarse.combinedCoarseCandidates.length,
    fine_assessment_count: manifested.candidates.length,
    degradation_reason: coarse.coarseFilter.degradation_reason,
    working_projection: null,
    delivery_path: assessment.finalAssessment.delivery_path,
    ranking_authority: assessment.finalAssessment.ranking_authority,
    ...(assessment.finalAssessment.capture_execution === undefined
      ? {}
      : { capture_execution: assessment.finalAssessment.capture_execution }),
    ...(assessment.finalAssessment.capture_identity === undefined
      ? {}
      : { capture_identity: assessment.finalAssessment.capture_identity }),
    diagnostics: buildRecallDiagnostics({
      captureReceipt: assessment.finalAssessment.capture_receipt,
      queryProbes: prepared.queryProbes,
      queryEntityExtraction: prepared.queryEntityExtraction,
      queryFactFrameExtraction:
        assessment.supplementaryData.queryFactFrameExtraction,
      queryOpenSemanticFactorFormation:
        assessment.supplementaryData.queryOpenSemanticFactorFormation,
      queryOpenSemanticFactorCompletenessReceipt:
        assessment.supplementaryData.queryOpenSemanticFactorCompletenessReceipt,
      openSemanticFactorCompatibilityTrace:
        assessment.supplementaryData.openSemanticFactorCompatibilityTrace,
      openSemanticFactorComposition:
        assessment.supplementaryData.openSemanticFactorComposition,
      openSemanticFactorActivation:
        assessment.supplementaryData.openSemanticFactorActivation,
      kindConstraintAlignment:
        assessment.supplementaryData.kindConstraintAlignment,
      retrievalFieldCaptures: assessment.retrievalFieldCaptures,
      retrievalFieldRefinementReceipts:
        assessment.supplementaryData.retrievalFieldRefinementReceipts,
      fieldRefinementStopCertificate:
        assessment.finalAssessment.fieldRefinementStopCertificate,
      queryCondition: queryConditionParityView(prepared.queryCondition),
      fieldProjectionTrace: Object.freeze({
        generation_id: prepared.queryCondition.generation_id,
        condition_digest: prepared.queryCondition.identity,
        ...prepared.fieldProjectionSelection
      }),
      querySoughtFacets: assessment.supplementaryData.querySoughtFacets,
      answerShapePlan: prepared.answerShapePlan,
      ...(includeCandidateEvidence
        ? { captureProofDiagnostics: buildCaptureProofDiagnostics(
          prepared,
          assessment,
          coarse.combinedCoarseCandidates
        ) }
        : {}),
      totalScanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
      candidatePoolCount: coarse.combinedCoarseCandidates.length,
      preBudgetCount: includeCandidateEvidence
        ? manifested.candidateDiagnostics.length
        : assessment.finalAssessment.diagnostics.length,
      deliveredCount: manifested.candidates.length,
      ...(assessment.packetPlanTrace === undefined
        ? {}
        : { packetPlanTrace: assessment.packetPlanTrace }),
      embeddingProviderStatus: assessment.embeddingProviderStatus,
      embeddingSupplementStatus: assessment.embeddingSupplementStatus,
      evidenceEmbeddingScoring: assessment.evidenceEmbeddingScoring,
      providerDegradationReason: assessment.providerDegradationReason,
      answerRerankDiagnostics: assessment.answerRerankDiagnostics,
      degradationReasons: [...degradationReasons],
      graphExpansionDiagnostics: coarse.coarseFilter.graphExpansionDiagnostics,
      candidates: includeCandidateEvidence
        ? manifested.candidateDiagnostics
        : EMPTY_RECALL_CANDIDATE_DIAGNOSTICS,
      fineAssessmentPrunedCandidates: includeCandidateEvidence
        ? buildFineAssessmentPrunedDiagnostics(
          coarse.combinedCoarseCandidates,
          assessment.finalAssessment.prunedCandidates
        )
        : EMPTY_FINE_ASSESSMENT_PRUNED_DIAGNOSTICS,
      includeCandidateEvidence,
      tokenEconomy,
      embeddingWorkspaceScan: assessment.embeddingCoarseInjection.workspaceScan,
      phaseLatencyMs
    })
  });
}

export function addRecallExecutionPhaseLatencies(
  result: RecallResult,
  executionPhases: RecallExecutionPhaseLatencyMs,
  elapsedMs: number,
  existingPhaseOwnerElapsedMs: number
): RecallResult {
  const diagnostics = result.diagnostics;
  const existingPhases = diagnostics?.phase_latency_ms;
  if (diagnostics === undefined || existingPhases === undefined) {
    return result;
  }
  const existingPhaseTotalMs = sumPhaseLatency(existingPhases);
  const existingPhaseOverageMs = Math.max(
    0,
    existingPhaseTotalMs - existingPhaseOwnerElapsedMs
  );
  const namedPhases = Object.freeze({ ...existingPhases, ...executionPhases });
  const namedEffectiveTotalMs = sumPhaseLatency(namedPhases) - existingPhaseOverageMs;
  const residualMs = elapsedMs - namedEffectiveTotalMs;
  return Object.freeze({
    ...result,
    diagnostics: Object.freeze({
      ...diagnostics,
      phase_latency_ms: Object.freeze({
        ...namedPhases,
        unattributed_residual: Math.max(0, residualMs),
        accounting_overage: existingPhaseOverageMs + Math.max(0, -residualMs)
      })
    })
  });
}

function sumPhaseLatency(phases: Readonly<Record<string, number>>): number {
  return Object.values(phases).reduce((sum, latencyMs) => sum + latencyMs, 0);
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
  manifested: RecallManifestedResult,
  includeCandidateEvidence: boolean
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
    preBudgetCandidates: includeCandidateEvidence
      ? manifested.candidateDiagnostics
      : assessment.finalAssessment.diagnostics,
    embeddingInferenceCalls:
      assessment.embeddingCoarseInjection.embeddingInferenceCalls +
      preparedEmbeddingInferenceCalls +
      assessment.evidenceEmbeddingScoring.inferenceCalls
  });
}
