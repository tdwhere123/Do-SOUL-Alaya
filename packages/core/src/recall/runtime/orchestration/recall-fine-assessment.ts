import type { EmbeddingWorkspaceNeighborResult } from
  "../../../embedding-recall/types.js";
import { withEmbeddingSimilarityScores } from
  "../../coarse-filter/embedding/embedding-similarity-supplement.js";
import {
  deliverFineAssessment,
  prepareFineAssessment,
  type FineAssessParams
} from "../../delivery/fine-assessment.js";
import { resolveFineAssessmentDeliveryPath } from "../../shadow/canonical-delivery.js";
import { buildRecallCandidateDedupeKey } from "../recall-service-helpers.js";
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
import { buildCaptureProofDiagnostics, type CaptureProofDiagnostics } from
  "../diagnostics/capture-proof-diagnostics.js";

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

export function mergeSnapshotSupplementaryData(
  coarse: CoarseStageResult,
  base: CollectedFineAssessmentData,
  embeddingData: EmbeddingAssessmentData
): FineAssessParams["supplementaryData"] {
  return withEmbeddingSimilarityScores(
    {
      ...base.supplementaryData,
      ...snapshotEmbeddingObservation(
        coarse.embeddingCoarseInjection.requestScoreSnapshot?.workspaceNeighbors ??
          coarse.embeddingCoarseInjection.observationNeighbors
      )
    },
    embeddingData.supplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    embeddingData.poolRescoreScores,
    attributedEvidenceActivations(base.supplementaryData, embeddingData),
    embeddingData.retrievalFieldSeal,
    embeddingData.retrievalFieldRefinementReceipts
  );
}

function snapshotEmbeddingObservation(
  neighbors: Readonly<EmbeddingWorkspaceNeighborResult> | undefined
): Pick<
  FineAssessParams["supplementaryData"],
  "embeddingObservationDomain" | "embeddingContentHashByObjectId"
> {
  if (neighbors === undefined) return {};
  const dimensions = neighbors.dimensions;
  const domain =
    neighbors.provider_kind !== undefined &&
    neighbors.provider_kind.length > 0 &&
    neighbors.model_id !== undefined &&
    neighbors.model_id.length > 0 &&
    neighbors.schema_version !== undefined &&
    dimensions !== undefined &&
    dimensions > 0
      ? Object.freeze({
        provider_kind: neighbors.provider_kind,
        model_id: neighbors.model_id,
        dimensions,
        schema_version: neighbors.schema_version
      })
      : undefined;
  const hashes: Record<string, string> = {};
  for (const hit of neighbors.hits) {
    if (hit.content_hash !== undefined && hit.content_hash.length > 0) {
      hashes[hit.object_id] = hit.content_hash;
    }
  }
  return {
    ...(domain === undefined ? {} : { embeddingObservationDomain: domain }),
    ...(Object.keys(hashes).length === 0
      ? {}
      : { embeddingContentHashByObjectId: Object.freeze(hashes) })
  };
}

export function prepareAssessmentAfterEmbedding(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  base: CollectedFineAssessmentData,
  embeddingData: EmbeddingAssessmentData
): Readonly<{
  readonly preparedCandidates: FineAssessmentPreparation | null;
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly assessmentLatencyMs: number;
}> {
  if (resolveFineAssessmentDeliveryPath(prepared.policy.fine_assessment) === "canonical") {
    return Object.freeze({
      preparedCandidates: null,
      supplementaryData: mergeSnapshotSupplementaryData(coarse, base, embeddingData),
      assessmentLatencyMs: 0
    });
  }
  const assessment = measureSync(() => prepareSnapshotAssessment(
    context, params, prepared, coarse, base, embeddingData
  ));
  return Object.freeze({
    preparedCandidates: assessment.value.preparedCandidates,
    supplementaryData: assessment.value.supplementaryData,
    assessmentLatencyMs: assessment.latencyMs
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
  const supplementaryData = mergeSnapshotSupplementaryData(coarse, base, embeddingData);
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

export function buildFineAssessParams(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  supplementaryData: FineAssessParams["supplementaryData"],
  candidates: FineAssessParams["candidates"],
  membership?: Readonly<{ readonly e0Keys: readonly string[] }>
): FineAssessParams {
  const captureAnswerFeatures = capturesRecallAnswerFeatures(params.diagnosticCapture);
  return {
    workspace_id: params.workspaceId,
    candidates,
    policy: prepared.policy,
    winnerMemoryIds: prepared.winnerMemoryIds,
    supplementaryData,
    tokenEstimator: prepared.tokenEstimator,
    now: () => prepared.referenceTime,
    warn: context.warn,
    captureAnswerFeatures,
    capturePacketPlanTrace: params.diagnosticCapture === "packet_trace",
    answerShapePlan: prepared.answerShapePlan,
    selectionBoundaryObserver: params.selectionBoundaryObserver,
    diagnosticObserver: params.diagnosticObserver,
    generation_id: prepared.queryCondition.generation_id,
    condition_digest: prepared.queryCondition.identity,
    memoryKeywordLanes: prepared.retrievalFieldBundle.memoryKeywordLanes(),
    memoryLexicalCaptures: prepared.retrievalFieldBundle.memoryLexicalCaptures(),
    ...buildPsiV2LiveReceiptInput(prepared, supplementaryData, candidates),
    ...(membership === undefined ? {} : captureFineAssessmentMembership(
      membership.e0Keys,
      candidates
    ))
  };
}

function buildPsiV2LiveReceiptInput(
  prepared: PreparedRecallRequest,
  supplementaryData: FineAssessParams["supplementaryData"],
  candidates: FineAssessParams["candidates"]
): Partial<FineAssessParams> {
  const diagnostics = buildCaptureProofDiagnostics(
    prepared,
    { supplementaryData },
    candidates
  );
  const lexicalBoundProofs = prepared.retrievalFieldBundle
    .memoryLexicalBoundProofsForSnapshot(prepared.snapshotVector.vector_digest);
  const supportCandidateReceipts = supportReceiptsFrom(diagnostics, supplementaryData);
  return {
    queryProofAuthority: Object.freeze({
      workspace_id: prepared.queryCondition.condition.workspace_id,
      query_condition: prepared.queryCondition,
      canonical_query_evidence: prepared.canonicalQueryEvidence,
      canonical_query_compilation: prepared.canonicalQueryCompilation,
      snapshot_vector: prepared.snapshotVector,
      snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
      snapshot_read_lease: prepared.snapshotReadLease,
      expected_lexical_request_pins:
        prepared.retrievalFieldBundle.memoryLexicalRequestPins()
    }),
    lexicalBoundProofs,
    ...(supportCandidateReceipts.length === 0 ? {} : { supportCandidateReceipts })
  };
}

function supportReceiptsFrom(
  diagnostics: CaptureProofDiagnostics,
  supplementaryData: FineAssessParams["supplementaryData"]
): readonly NonNullable<FineAssessParams["supportCandidateReceipts"]>[number][] {
  return Object.freeze(Object.values(diagnostics.candidate_proposition_provenance)
    .flatMap((row) => supportReceiptFrom(row, supplementaryData)));
}

function supportReceiptFrom(
  row: CaptureProofDiagnostics["candidate_proposition_provenance"][string],
  supplementaryData: FineAssessParams["supplementaryData"]
): readonly NonNullable<FineAssessParams["supportCandidateReceipts"]>[number][] {
  const available = row.osf.bindings.status === "available" ||
    row.typed_fact_frames.status === "available" ||
    row.evidence_links.status === "available";
  if (!available) return [];
  const bindings = row.osf.bindings.status === "available"
    ? row.osf.bindings.value.map((binding) => Object.freeze({
      variable_id: binding.variable_id,
      binding_identity: binding.binding_identity,
      semantic_identity: binding.semantic_identity,
      evidence_id: binding.evidence_id,
      ...(binding.query_proposition_id === undefined
        ? {}
        : { query_proposition_id: binding.query_proposition_id })
    }))
    : undefined;
  const factFrames = row.typed_fact_frames.status === "available"
    ? row.typed_fact_frames.value.flatMap(({ capture, evidence_id }) =>
      capture.fact_frame === null ? [] : capture.fact_frame.slots.map((slot) =>
        Object.freeze({
          semantic_identity: slot.text,
          role: slot.role,
          evidence_id
        })))
    : undefined;
  return [Object.freeze({
    candidate_key: row.candidate_key,
    osf: Object.freeze({
      composition_status: row.osf.composition_status,
      truncated: supplementaryData.openSemanticFactorComposition?.truncated ?? false,
      ...(bindings === undefined ? {} : { bindings: Object.freeze(bindings) })
    }),
    ...(factFrames === undefined ? {} : { fact_frames: Object.freeze(factFrames) }),
    ...(row.evidence_links.status === "available"
      ? { evidence_ids: row.evidence_links.value }
      : {})
  })];
}

export function captureFineAssessmentMembership(
  e0Keys: readonly string[],
  candidates: FineAssessParams["candidates"]
): Readonly<{ readonly e0Keys: readonly string[]; readonly e1Keys: readonly string[] }> {
  return Object.freeze({
    e0Keys: Object.freeze([...e0Keys]),
    e1Keys: Object.freeze(candidates.map(buildRecallCandidateDedupeKey))
  });
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
    querySemanticFactorFormationCapture:
      prepared.querySemanticFactorFormationCapture ??
      params.querySemanticFactorFormationCapture,
    querySemanticFactorCompletenessReceipt:
      prepared.querySemanticFactorCompletenessReceipt === undefined
        ? params.querySemanticFactorCompletenessReceipt
        : prepared.querySemanticFactorCompletenessReceipt,
    winnerMemoryIds: prepared.winnerMemoryIds,
    tokenEstimator: prepared.tokenEstimator,
    captureAnswerFeatures: capturesRecallAnswerFeatures(params.diagnosticCapture),
    degradationReasons: context.degradationReasons
  };
}
