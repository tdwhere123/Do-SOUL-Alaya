import { performance } from "node:perf_hooks";
import {
  RecallContextEventType,
  SoulRecallCompletedPayloadSchema,
  type RecallPolicy,
  type SoulRecallHostContext,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import { withEmbeddingSimilarityScores } from "./coarse-candidates.js";
import { resolveHydeQueryText } from "./query-hyde.js";
import { fineAssess } from "./fine-assessment.js";
import {
  applyManifestationBiasSidecar,
  appendWeightTransferTelemetry,
  assessCoarseFilter,
  loadActiveConstraints,
  recordGlobalRecallClassificationsSafely,
  resolvePolicy
} from "./orchestration.js";
import { compileRecallQueryProbes, type RecallQueryProbes } from "./recall-query-probes.js";
import {
  buildRecallDiagnostics,
  computeRecallTokenEconomy,
  finalizeRecallCandidateDiagnostics,
  resolveEmbeddingProviderDegradationReason,
  resolveEmbeddingProviderStatus
} from "./diagnostics.js";
import {
  normalizeQueryText,
  type RecallTimeFilter
} from "./recall-service-helpers.js";
import type {
  RecallCandidateDiagnostic,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  RecallTokenEconomy,
  TokenEstimator
} from "./recall-service-types.js";
import { makeTokenEstimator } from "./recall-service-types.js";
import {
  collectEmbeddingSupplement,
  prepareEmbeddingSupplementQuery
} from "./supplements.js";
import {
  collectCoarseStage,
  type CoarseStageResult,
  type EmbeddingCoarseInjectionResult
} from "./recall-service-runner-coarse.js";

const RECALLS_EDGE_COLD_THRESHOLD = 50;

export interface RecallExecutionParams {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workspaceId: string;
  readonly strategy: NodeStrategy;
  readonly runId?: string | null;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly timeFilter?: RecallTimeFilter;
  readonly hostContext?: Readonly<SoulRecallHostContext>;
  readonly activeConstraintsCap?: number | null;
}

export interface RecallExecutionContext {
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly buildDefaultPolicy: (strategy: NodeStrategy, taskSurfaceRef: string) => Readonly<RecallPolicy>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

type ActiveConstraintsResult = Awaited<ReturnType<typeof loadActiveConstraints>>;
type PreparedEmbeddingQuery = Awaited<ReturnType<typeof prepareEmbeddingSupplementQuery>>;
type FineAssessmentResult = ReturnType<typeof fineAssess>;

export interface PreparedRecallRequest {
  readonly policy: Readonly<RecallPolicy>;
  readonly tokenEstimator: TokenEstimator;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly activeConstraints: ActiveConstraintsResult;
  readonly winnerMemoryIds: ReadonlySet<string>;
}

interface AssessmentStageResult {
  readonly finalAssessment: FineAssessmentResult;
  readonly supplementaryData: FineAssessmentResult extends never ? never : PreparedRecallSupplementaryData;
  readonly preparedEmbeddingQuery: PreparedEmbeddingQuery;
  readonly embeddingCoarseInjection: EmbeddingCoarseInjectionResult;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly providerDegradationReason: string | null;
  readonly recallAfterFusion: number;
}

type PreparedRecallSupplementaryData = Parameters<typeof fineAssess>[0]["supplementaryData"];

interface ManifestedRecallResult {
  readonly candidates: RecallResult["candidates"];
  readonly candidateDiagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly recallAfterManifestation: number;
}

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
    buildDefaultPolicy: context.buildDefaultPolicy
  });
  const tokenEstimator = makeTokenEstimator({ hint: params.hostContext?.tokenizer_hint });
  const queryText = normalizeQueryText(params.taskSurface.display_name);
  const queryProbes = compileRecallQueryProbes(queryText);
  const [slots, activeConstraints] = await Promise.all([
    context.dependencies.slotRepo.findByWorkspace(params.workspaceId),
    loadActiveConstraints({
      activeConstraintsPort: context.dependencies.activeConstraintsPort,
      workspaceId: params.workspaceId,
      cap: params.activeConstraintsCap ?? null
    })
  ]);
  return Object.freeze({
    policy,
    tokenEstimator,
    queryText,
    queryProbes,
    activeConstraints,
    winnerMemoryIds: await resolveWinnerMemoryIds(context, params.workspaceId, slots)
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
  const preparedEmbeddingQueryPromise = startEmbeddingSupplementPreparation(context, params, prepared, coarse);
  const initialAssessment = await runInitialFineAssessment(context, params, prepared, coarse);
  const preparedEmbeddingQuery = await unwrapPreparedEmbeddingQuery(preparedEmbeddingQueryPromise);
  const embeddingSupplement = await collectEmbeddingSupplementStage(context, params, prepared, coarse, initialAssessment, preparedEmbeddingQuery);
  const poolRescoreScores = await collectPoolEmbeddingRescore(context, params, prepared, coarse);
  const supplementaryData = withEmbeddingSimilarityScores(
    initialAssessment.supplementaryData,
    embeddingSupplement.similarityHintsByObjectId,
    coarse.embeddingCoarseInjection.similarityScores,
    poolRescoreScores
  );
  const finalAssessment = needsEmbeddingReassessment(embeddingSupplement, coarse.embeddingCoarseInjection) ||
    Object.keys(poolRescoreScores).length > 0
    ? fineAssess({
        candidates: coarse.combinedCoarseCandidates,
        policy: prepared.policy,
        winnerMemoryIds: prepared.winnerMemoryIds,
        supplementaryData,
        tokenEstimator: prepared.tokenEstimator,
        now: context.now,
        warn: context.warn
      })
    : initialAssessment;
  const provider = resolveEmbeddingProvider(prepared.policy, preparedEmbeddingQuery, coarse.embeddingCoarseInjection);
  return Object.freeze({
    finalAssessment,
    supplementaryData,
    preparedEmbeddingQuery,
    embeddingCoarseInjection: coarse.embeddingCoarseInjection,
    embeddingProviderStatus: provider.status,
    providerDegradationReason: provider.degradationReason,
    recallAfterFusion: performance.now()
  });
}

// Default-ON (opt-out via ALAYA_RECALL_EMBED_POOL_RESCORE=off): score pooled candidates by
// cosine(query, stored-vector) so embedding re-ranks a buried-but-pooled gold — the inverse of
// injection (which excludes pooled ids). No-op when embedding is disabled. HyDE-aware via
// resolveHydeQueryText. Paired with embedding_similarity default weight 12 (weight 1 is too weak).
function embedPoolRescoreEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_EMBED_POOL_RESCORE;
  return raw !== "off" && raw !== "0" && raw !== "false";
}

async function collectPoolEmbeddingRescore(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<Readonly<Record<string, number>>> {
  const service = context.dependencies.embeddingRecallService;
  if (
    !embedPoolRescoreEnabled() ||
    prepared.queryText === null ||
    service === undefined ||
    typeof service.scorePoolCandidates !== "function" ||
    prepared.policy.coarse_filter.semantic_supplement.embedding_enabled !== true
  ) {
    return {};
  }
  const objectIds = coarse.combinedCoarseCandidates.map((candidate) => candidate.entry.object_id);
  if (objectIds.length === 0) {
    return {};
  }
  const scores = await service.scorePoolCandidates({
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: resolveHydeQueryText(prepared.queryText)!,
    objectIds
  });
  return Object.fromEntries(scores);
}

function startEmbeddingSupplementPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<{ readonly status: "fulfilled"; readonly value: PreparedEmbeddingQuery } | { readonly status: "rejected"; readonly reason: unknown }> {
  return prepareEmbeddingSupplementQuery({
    dependencies: context.dependencies,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    localEligibleCandidates: coarse.coarseFilter.candidates,
    lexicalFallbackCount: Math.min(coarse.combinedCoarseCandidates.length, prepared.policy.fine_assessment.budgets.max_entries)
  }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

async function runInitialFineAssessment(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<Awaited<ReturnType<typeof assessCoarseFilter>>> {
  return assessCoarseFilter({
    dependencies: context.dependencies,
    warn: context.warn,
    now: context.now,
    coarseFilter: Object.freeze({ ...coarse.coarseFilter, candidates: coarse.combinedCoarseCandidates }),
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    policy: prepared.policy,
    queryProbes: prepared.queryProbes,
    winnerMemoryIds: prepared.winnerMemoryIds,
    tokenEstimator: prepared.tokenEstimator
  });
}

async function unwrapPreparedEmbeddingQuery(
  promise: Promise<{ readonly status: "fulfilled"; readonly value: PreparedEmbeddingQuery } | { readonly status: "rejected"; readonly reason: unknown }>
): Promise<PreparedEmbeddingQuery> {
  const result = await promise;
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

async function collectEmbeddingSupplementStage(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  initialAssessment: Awaited<ReturnType<typeof assessCoarseFilter>>,
  preparedEmbeddingQuery: PreparedEmbeddingQuery
): Promise<Awaited<ReturnType<typeof collectEmbeddingSupplement>>> {
  return collectEmbeddingSupplement({
    dependencies: context.dependencies,
    baseCandidateIds: initialAssessment.candidates.map((candidate) => candidate.object_id),
    localEligibleCandidates: coarse.coarseFilter.candidates,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
    preparedStoredVectors: preparedEmbeddingQuery.storedVectors
  });
}

function needsEmbeddingReassessment(
  supplement: Awaited<ReturnType<typeof collectEmbeddingSupplement>>,
  injection: EmbeddingCoarseInjectionResult
): boolean {
  return Object.keys(supplement.similarityHintsByObjectId).length > 0 || injection.candidates.length > 0;
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
    candidateDiagnostics: finalizeRecallCandidateDiagnostics(finalAssessment.diagnostics, candidates),
    recallAfterManifestation: performance.now()
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
  await appendWeightTransferTelemetry({
    eventLogRepo: context.dependencies.eventLogRepo,
    warn: context.warn,
    now: context.now,
    recallsEdgeColdThreshold: RECALLS_EDGE_COLD_THRESHOLD,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    graphAndPathColdScore: assessment.supplementaryData.graphAndPathColdScore,
    recallsEdgeCount: assessment.supplementaryData.recallsEdgeCount,
    weightTransferAmount: assessment.supplementaryData.weightTransferAmount
  });
  await recordGlobalRecallClassificationsSafely({
    globalRecallCachePort: context.dependencies.globalRecallCachePort,
    warn: context.warn,
    classifications: coarse.globalRecallClassifications
  });
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

function buildRecallResult(
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  assessment: AssessmentStageResult,
  manifested: ManifestedRecallResult,
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
  assessment: AssessmentStageResult,
  manifested: ManifestedRecallResult
): Readonly<Record<string, number>> {
  return Object.freeze({
    coarse: coarse.recallAfterCoarse - coarse.recallPhaseStart,
    synthesis: coarse.recallAfterSynthesis - coarse.recallAfterCoarse,
    fusion: assessment.recallAfterFusion - coarse.recallAfterSynthesis,
    manifestation: manifested.recallAfterManifestation - assessment.recallAfterFusion
  });
}

function buildTokenEconomy(
  assessment: AssessmentStageResult,
  coarsePoolSize: number,
  manifested: ManifestedRecallResult
): Readonly<RecallTokenEconomy> {
  const preparedEmbeddingInferenceCalls =
    assessment.embeddingProviderStatus === "provider_returned" && assessment.preparedEmbeddingQuery.handle?.cacheHit === false ? 1 : 0;
  return computeRecallTokenEconomy({
    deliveredCandidates: manifested.candidates,
    coarsePoolSize,
    fineEvaluated: coarsePoolSize,
    preBudgetCandidates: manifested.candidateDiagnostics,
    embeddingInferenceCalls: assessment.embeddingCoarseInjection.embeddingInferenceCalls + preparedEmbeddingInferenceCalls
  });
}
