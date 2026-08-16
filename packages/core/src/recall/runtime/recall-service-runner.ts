import {
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { FineAssessParams } from "../delivery/fine-assessment.js";
import { captureSupportSetPacketPlanTrace } from
  "../delivery/packet-plan/packet-plan-trace.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
  loadActiveConstraints,
  recordGlobalRecallClassificationsSafely,
  resolvePolicy
} from "./orchestration.js";
import { compileRecallQueryProbes } from "../query/recall-query-probes.js";
import { extendQueryProbesWithOpenSemanticFactors } from
  "../query/query-factor-expanded-terms.js";
import { resolvePreparedAnswerShapePlan } from "../query/recall-answer-shape-plan.js";
import {
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./diagnostics.js";
import {
  errorNameOf,
  normalizeQueryText,
  toErrorMessage
} from "./recall-service-helpers.js";
import { captureRecallQueryEntities } from
  "../field/query-entity-attribution-producer.js";
import { createRecallRetrievalFieldBundle } from
  "../field/retrieval/retrieval-field-bundle.js";
import type {
  CoarseRecallCandidate,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  collectCoarseStage,
  type CoarseStageResult,
  type EmbeddingCoarseInjectionResult
} from "./recall-service-runner-coarse.js";
import {
  collectLegacyEmbeddingAssessmentData,
  collectSnapshotEmbeddingAssessmentData,
  startEmbeddingAssessmentPreparation,
  type EmbeddingAssessmentData
} from "./orchestration/recall-embedding-assessment.js";
import { buildRecallResult } from "./recall-result-builder.js";
import {
  collectTimedSupplementaryData,
  deliverOrReuseAssessment,
  prepareSnapshotAssessment
} from "./orchestration/recall-fine-assessment.js";
import {
  instantTimedResult,
  measureAsync,
  measureSync
} from "./orchestration/recall-phase-latency.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { createInMemoryFieldQuerySession } from "./query/field-query-session.js";
import { capturePreparedRequestCondition } from
  "./query/prepare-recall-query-condition.js";
import {
  type FineAssessmentResult,
  type FineAssessmentPreparation,
  type PreparedEmbeddingQuery,
  type PreparedRecallRequest,
  type RecallAssessmentStageResult,
  type RecallExecutionContext,
  type RecallExecutionParams,
  type RecallManifestedResult
} from "./recall-service-runner-types.js";

export type { RecallExecutionContext, RecallExecutionParams, PreparedRecallRequest } from "./recall-service-runner-types.js";

type AssessmentStageResult = RecallAssessmentStageResult;
type ManifestedRecallResult = RecallManifestedResult;
type AssessmentPhaseSeed = Readonly<{
  readonly embedding: number;
  readonly assessment: number;
  readonly delivery: number;
}>;
const RECALLS_EDGE_COLD_THRESHOLD = 50;

export async function executeRecall(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<RecallResult> {
  const degradationReasons = new Set<RecallDegradationReason>();
  const executionContext = Object.freeze({ ...context, degradationReasons });
  const prepared = await prepareRecallRequest(executionContext, params);
  const coarse = await collectCoarseStage(executionContext, params, prepared);
  const assessment = await assessCandidateStage(executionContext, params, prepared, coarse);
  const manifested = await manifestCandidateStage(executionContext, params, assessment.finalAssessment);
  await recordRecallSideEffects(executionContext, params, prepared, coarse, assessment, manifested);
  return buildRecallResult(prepared, coarse, assessment, manifested, degradationReasons);
}

async function prepareRecallRequest(
  context: RecallExecutionContext,
  params: RecallExecutionParams
): Promise<PreparedRecallRequest> {
  const policy = resolvePolicy({
    strategy: params.strategy,
    taskSurfaceRef: params.taskSurface.runtime_id,
    policyOverride: params.policyOverride,
    buildDefaultPolicy: context.buildDefaultPolicy,
    defaultPolicyDecorator: context.dependencies.defaultPolicyDecorator
  });
  const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
  const queryText = normalizeQueryText(params.taskSurface.display_name);
  const queryProbes = extendQueryProbesWithOpenSemanticFactors(
    compileRecallQueryProbes(queryText),
    params.querySemanticFactorFormationCapture
  );
  const answerShapePlan = resolvePreparedAnswerShapePlan(queryProbes);
  const capturedCondition = capturePreparedRequestCondition({
    workspaceId: params.workspaceId,
    explicitAsOf: params.referenceTime,
    queryText,
    tokenBudget: policy.fine_assessment.budgets.max_total_tokens,
    activationBudget: policy.fine_assessment.budgets.max_entries,
    sha256: context.sha256 ?? fieldContractSha256,
    now: context.now,
    session: context.fieldQuerySession ??
      createInMemoryFieldQuerySession(context.sha256 ?? fieldContractSha256)
  });
  const queryCondition = capturedCondition.receipt;
  const referenceTime = capturedCondition.referenceTime;
  const retrievalFieldBundle = createRecallRetrievalFieldBundle({
    workspaceId: params.workspaceId,
    queryText,
    memoryRepo: context.dependencies.memoryRepo,
    evidenceSearchPort: context.dependencies.evidenceSearchPort,
    synthesisSearchPort: context.dependencies.synthesisSearchPort,
    refinementMaxDepth:
      policy.coarse_filter.semantic_supplement.field_observation_max_depth,
    onFailure: (operation, error) => context.warn("retrieval field query failed", {
      workspace_id: params.workspaceId,
      operation,
      error: toErrorMessage(error)
    }),
    onBatchFailure: (operation, failure) => context.warn(
      "retrieval field batch query failed; using scalar field queries",
      {
        workspace_id: params.workspaceId,
        operation,
        ...failure
      }
    )
  });
  const [slots, activeConstraints, queryEntityExtraction] = await Promise.all([
    context.dependencies.slotRepo.findByWorkspace(params.workspaceId),
    loadActiveConstraints({
      activeConstraintsPort: context.dependencies.activeConstraintsPort,
      warn: context.warn,
      workspaceId: params.workspaceId,
      cap: params.activeConstraintsCap ?? null,
      asOf: referenceTime
    }),
    captureRecallQueryEntities({
      query_text: queryText,
      port: context.dependencies.entityExtractionPort,
      on_failure: (error) => context.warn("entity extraction failed", {
        workspace_id: params.workspaceId,
        operation: "entity_extraction",
        errorName: errorNameOf(error),
        error: toErrorMessage(error)
      })
    })
  ]);
  return Object.freeze({
    policy,
    tokenEstimator,
    queryText,
    queryProbes,
    queryEntityExtraction,
    retrievalFieldBundle,
    answerShapePlan,
    referenceTime,
    temporalProjectionAsOf: referenceTime,
    activeConstraints,
    winnerMemoryIds: await resolveWinnerMemoryIds(context, params.workspaceId, slots),
    queryCondition
  });
}

async function resolveWinnerMemoryIds(
  context: RecallExecutionContext,
  workspaceId: string,
  slots: Awaited<ReturnType<RecallServiceDependencies["slotRepo"]["findByWorkspace"]>>
): Promise<ReadonlySet<string>> {
  const winnerClaimIds = new Set(slots.flatMap((slot) => (slot.winner_claim_id === null ? [] : [slot.winner_claim_id])));
  if (winnerClaimIds.size === 0 || context.dependencies.claimResolverPort === undefined) {
    return new Set();
  }
  const claims = await context.dependencies.claimResolverPort.findByIds(workspaceId, [...winnerClaimIds]);
  return new Set(claims.flatMap((claim) => claim.source_object_refs).filter((ref): ref is string => ref !== undefined));
}

async function assessCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  if (coarse.embeddingCoarseInjection.requestScoreSnapshot !== undefined) {
    return assessSnapshotCandidateStage(context, params, prepared, coarse);
  }
  return assessLegacyCandidateStage(context, params, prepared, coarse);
}

async function assessLegacyCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  const embeddingPreparation = startLegacyEmbeddingPreparation(
    context, params, prepared, coarse, coarse.combinedCoarseCandidates
  );
  const base = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const preparedEmbeddingQuery = await embeddingPreparation;
  const embedding = await measureAsync(() => collectLegacyEmbeddingAssessmentData(
    context,
    params,
    prepared,
    coarse,
    base.value.supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {},
    coarse.combinedCoarseCandidates,
    preparedEmbeddingQuery.value
  ));
  const assessment = measureSync(() => prepareSnapshotAssessment(
    context, params, prepared, coarse, base.value, embedding.value
  ));
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    assessment.value.preparedCandidates,
    assessment.value.supplementaryData,
    embedding.value,
    Object.freeze({
      embedding: preparedEmbeddingQuery.latencyMs + embedding.latencyMs,
      assessment: base.latencyMs + assessment.latencyMs,
      delivery: 0
    }),
    "legacy"
  );
}

function startLegacyEmbeddingPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[]
) {
  return measureAsync(() => {
    const pending = startEmbeddingAssessmentPreparation(
      context, params, prepared, coarse, fineCandidates
    );
    if (pending === null) {
      throw new Error("legacy embedding preparation is unavailable");
    }
    return pending;
  });
}

async function assessSnapshotCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<AssessmentStageResult> {
  const base = await collectTimedSupplementaryData(context, params, prepared, coarse);
  const embedding = await measureAsync(() => collectSnapshotEmbeddingAssessmentData(
    context,
    prepared,
    coarse,
    coarse.combinedCoarseCandidates,
    base.value.supplementaryData.evidenceSemanticDocumentsByMemoryId ?? {}
  ));
  const assessment = measureSync(() => prepareSnapshotAssessment(
    context, params, prepared, coarse, base.value, embedding.value
  ));
  return completeCandidateAssessment(
    context,
    params,
    prepared,
    coarse,
    assessment.value.preparedCandidates,
    assessment.value.supplementaryData,
    embedding.value,
    Object.freeze({
      embedding: embedding.latencyMs,
      assessment: base.latencyMs + assessment.latencyMs,
      delivery: 0
    }),
    "snapshot"
  );
}

async function completeCandidateAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  preparedCandidates: FineAssessmentPreparation,
  supplementaryData: FineAssessParams["supplementaryData"],
  embeddingData: EmbeddingAssessmentData,
  phaseLatency: AssessmentPhaseSeed,
  assessmentPath: "legacy" | "snapshot"
): Promise<AssessmentStageResult> {
  const { preparedEmbeddingQuery } = embeddingData;
  const rerank = instantTimedResult(collectAnswerRerankStage(supplementaryData));
  const delivery = deliverOrReuseAssessment(
    context, params, prepared, preparedCandidates, rerank.value
  );
  const provider = resolveEmbeddingProvider(prepared.policy, preparedEmbeddingQuery, coarse.embeddingCoarseInjection);
  if (embeddingData.evidenceScoring.status === "failed") {
    context.degradationReasons?.add("evidence_candidate_embedding_failed");
  }
  const packetPlanTrace = captureAssessmentPacketPlanTrace(
    context, assessmentPath, delivery.value.packetPlanObservation
  );
  return Object.freeze({
    finalAssessment: delivery.value,
    supplementaryData: rerank.value.supplementaryData,
    preparedEmbeddingQuery,
    embeddingCoarseInjection: coarse.embeddingCoarseInjection,
    embeddingProviderStatus: provider.status,
    embeddingSupplementStatus: embeddingData.supplement.collectionStatus,
    evidenceEmbeddingScoring: embeddingData.evidenceScoring,
    retrievalFieldCaptures: embeddingData.retrievalFieldCaptures,
    providerDegradationReason: provider.degradationReason,
    answerRerankDiagnostics: rerank.value.diagnostics,
    ...(packetPlanTrace === undefined ? {} : { packetPlanTrace }),
    phaseLatencyMs: Object.freeze({
      embedding: phaseLatency.embedding,
      assessment: phaseLatency.assessment,
      cross_rerank: rerank.latencyMs,
      delivery: phaseLatency.delivery + delivery.latencyMs
    })
  });
}

function captureAssessmentPacketPlanTrace(
  context: RecallExecutionContext,
  assessmentPath: "legacy" | "snapshot",
  observation: FineAssessmentResult["packetPlanObservation"]
) {
  if (observation === undefined) return undefined;
  const capture = captureSupportSetPacketPlanTrace(assessmentPath, observation);
  if (capture.status === "captured") return capture.trace;
  context.degradationReasons?.add("packet_plan_trace_capture_failed");
  context.warn("recall packet plan trace capture failed", capture.failure);
  return undefined;
}

function collectAnswerRerankStage(
  supplementaryData: FineAssessParams["supplementaryData"]
): Readonly<{
  readonly supplementaryData: FineAssessParams["supplementaryData"];
  readonly diagnostics: AssessmentStageResult["answerRerankDiagnostics"];
  readonly applied: boolean;
}> {
  return Object.freeze({
    supplementaryData,
    diagnostics: Object.freeze({
      status: "not_requested" as const,
      expected_count: 0,
      scored_count: 0,
      failure_class: null
    }),
    applied: false
  });
}

function resolveEmbeddingProvider(
  policy: Readonly<RecallPolicy>,
  preparedEmbeddingQuery: PreparedEmbeddingQuery,
  injection: EmbeddingCoarseInjectionResult
): Readonly<{ readonly status: RecallEmbeddingProviderStatus; readonly degradationReason: string | null }> {
  const preparedStatus = resolveEmbeddingProviderStatus(policy, preparedEmbeddingQuery.handle, preparedEmbeddingQuery.degradedReason);
  const preparedReason = resolveEmbeddingProviderDegradationReason(policy, preparedEmbeddingQuery.handle, preparedEmbeddingQuery.degradedReason);
  return Object.freeze({
    status: preparedStatus === "provider_not_requested" && injection.embeddingProviderStatus !== null
      ? injection.embeddingProviderStatus
      : preparedStatus,
    degradationReason: preparedReason === null && preparedStatus === "provider_not_requested"
      ? injection.providerDegradationReason
      : preparedReason
  });
}

async function manifestCandidateStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  finalAssessment: FineAssessmentResult
): Promise<ManifestedRecallResult> {
  const manifested = await measureAsync(async () => {
    const candidates = await applyManifestationBiasSidecar({
      manifestationSidecarPort: context.dependencies.manifestationSidecarPort,
      warn: context.warn,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      taskSurfaceRef: params.taskSurface,
      candidates: finalAssessment.candidates
    });
    return Object.freeze({
      candidates,
      candidateDiagnostics: finalizeRecallCandidateDiagnostics(
        finalAssessment.diagnostics, candidates
      )
    });
  });
  return Object.freeze({
    ...manifested.value,
    manifestationLatencyMs: manifested.latencyMs
  });
}

async function recordRecallSideEffects(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: AssessmentStageResult,
  manifested: ManifestedRecallResult
): Promise<void> {
  await appendRecallCompletedEvent(context, params, prepared, coarse, manifested);
  await Promise.all([
    appendWeightTransferTelemetry({
      eventLogRepo: context.dependencies.eventLogRepo,
      warn: context.warn,
      now: context.now,
      recallsEdgeColdThreshold: RECALLS_EDGE_COLD_THRESHOLD,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      graphAndPathColdScore: assessment.supplementaryData.graphAndPathColdScore,
      recallsEdgeCount: assessment.supplementaryData.recallsEdgeCount,
      weightTransferAmount: assessment.supplementaryData.weightTransferAmount
    }),
    recordGlobalRecallClassificationsSafely({
      globalRecallCachePort: context.dependencies.globalRecallCachePort,
      warn: context.warn,
      classifications: coarse.globalRecallClassifications
    })
  ]);
}

async function appendRecallCompletedEvent(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  _prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  manifested: ManifestedRecallResult
): Promise<void> {
  await context.dependencies.eventLogRepo.append({
    event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
    entity_type: "task_object_surface",
    entity_id: params.taskSurface.runtime_id,
    workspace_id: params.workspaceId,
    run_id: params.runId ?? null,
    caused_by: "system",
    payload_json: SoulRecallCompletedPayloadSchema.parse({
      task_surface_ref: params.taskSurface.runtime_id,
      node_strategy: params.strategy,
      total_scanned: coarse.coarseFilter.total_scanned + coarse.globalCoarseFilter.total_scanned,
      coarse_filter_count: coarse.combinedCoarseCandidates.length,
      fine_assessment_count: manifested.candidates.length,
      workspace_id: params.workspaceId,
      occurred_at: context.now()
    })
  });
}
