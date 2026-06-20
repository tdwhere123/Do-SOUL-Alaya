import {
  reportAsyncSideEffectFailure,
  scheduleAuditedAsyncSideEffect,
  type AsyncSideEffectAuditEventLogPort,
  type AsyncSideEffectAuditNotifierPort
} from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  SoulReportContextUsageResponseSchema,
  StorageTier,
  TaskObjectSurfaceSchema,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type SoulMemorySearchDegradationReason,
  type SoulMemorySearchRequest,
  type SoulRecallHostContext,
  type SoulReportContextUsageRequest,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput, GardenTaskRow } from "@do-soul/alaya-storage";
import type { GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import { enqueuePostTurnExtractTask, enqueueRecallExtractTask } from "./post-turn-extract-queue.js";
import { buildMemorySearchResult, buildRecallStrategyMix } from "./recall-result.js";
import { buildRecallPolicy, dedupeDeliveredObjectIdentities, uniqueObjectIds } from "./recall-usage-recall-support.js";
import {
  emitContextUsageReportedTelemetry,
  emitRecallDeliveredTelemetry
} from "./recall-usage-telemetry.js";
import {
  accrueCoRecallPlasticity,
  crossLinkRecalledMemories,
  promoteRecallHitMemories,
  resolveUsageState,
  resolveUsedObjectIds,
  validateReportedRecallHits,
  validateUsageStateConsistency
} from "./recall-usage-support.js";

type MemoryUsageRefreshFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};

export interface RecallUsageToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly sessionId: string;
  readonly surfaceId?: string | null;
}

export interface RecallUsageHandlerDependencies {
  readonly recallService: {
    recall(params: {
      readonly taskSurface: ReturnType<typeof TaskObjectSurfaceSchema.parse>;
      readonly workspaceId: string;
      readonly strategy: "chat" | "analyze" | "build" | "govern";
      readonly runId?: string | null;
      readonly policyOverride?: Readonly<RecallPolicy>;
      readonly timeFilter?: Readonly<{
        readonly since?: string | null;
        readonly until?: string | null;
        readonly field?: "created_at" | "last_used_at";
      }>;
      readonly hostContext?: Readonly<SoulRecallHostContext>;
      readonly activeConstraintsCap?: number | null;
    }): Promise<Readonly<{
      readonly candidates: readonly Readonly<RecallCandidate>[];
      readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
      readonly active_constraints_count: number;
      readonly total_scanned: number;
      readonly coarse_filter_count: number;
      readonly fine_assessment_count: number;
      readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
    }>>;
  };
  readonly trustStateRecorder: {
    recordDelivery(input: Omit<ContextDeliveryRecord, "audit_event_id">): Promise<ContextDeliveryRecord>;
    recordUsage(
      input: Omit<UsageProofRecord, "audit_event_id">,
      options?: { readonly expectedWorkspaceId?: string }
    ): Promise<UsageProofRecord>;
    findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
  };
  readonly pathRelationProposalService?: {
    onCoUsage(
      usedObjectIds: readonly string[],
      workspaceId: string
    ): Promise<void>;
    onCoRecall(
      recalledObjectIds: readonly string[],
      workspaceId: string,
      allowedPairKeys?: ReadonlySet<string>
    ): Promise<void>;
  };
  readonly coRecallCoherenceGate?: {
    coherentPairKeys(
      workspaceId: string,
      deliveredObjectIds: readonly string[]
    ): Promise<ReadonlySet<string>>;
  };
  readonly memoryService: {
    findByIdScoped(
      objectId: string,
      workspaceId: string
    ): Promise<Readonly<MemoryEntry> | null>;
    findByIdsScoped?(
      objectIds: readonly string[],
      workspaceId: string
    ): Promise<readonly Readonly<MemoryEntry>[]>;
    updateScoped?(
      objectId: string,
      workspaceId: string,
      fields: MemoryUsageRefreshFields,
      reason: string
    ): Promise<Readonly<MemoryEntry>>;
  };
  readonly eventPublisher?: {
    appendManyWithMutation<T>(
      inputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T>;
  };
  readonly asyncSideEffectAudit?: {
    readonly eventLogRepo: AsyncSideEffectAuditEventLogPort;
    readonly runtimeNotifier?: AsyncSideEffectAuditNotifierPort;
  };
  readonly memoryEntryRepo?: {
    updateTier(input: {
      readonly objectId: string;
      readonly workspaceId: string;
      readonly fromTier: StorageTier;
      readonly toTier: StorageTier;
      readonly updatedAt: string;
      readonly expectedUpdatedAt: string;
      readonly activationBump?: number;
      readonly lastUsedAt?: string;
      readonly lastHitAt?: string;
    }): Readonly<MemoryEntry> | null;
  };
  readonly dynamicsService?: {
    emitKarmaEvent(input: {
      readonly kind: "reuse_gain";
      readonly objectId: string;
      readonly workspaceId: string;
      readonly runId?: string | null;
    }): Promise<void>;
  };
  readonly graphEdgePort?: GraphEdgeCreationPort;
  readonly gardenTaskRepo?: {
    enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
    findById(taskId: string): GardenTaskRow | null;
    peekPending(
      role: string,
      workspace_id?: string,
      limit?: number
    ): readonly GardenTaskRow[];
  };
}

export type WarnPort = (message: string, meta: Record<string, unknown>) => void;

export function createRecallHandler(params: Readonly<{
  readonly deps: RecallUsageHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
  readonly generateId: () => string;
}>) {
  return async function recall(
    request: SoulMemorySearchRequest,
    context: RecallUsageToolCallContext
  ) {
    return await executeRecall(params, request, context);
  };
}

type RecallHandlerParams = Parameters<typeof createRecallHandler>[0];
type RecallServiceResult = Awaited<ReturnType<RecallUsageHandlerDependencies["recallService"]["recall"]>>;
type RecallSearchResult = ReturnType<typeof buildMemorySearchResult>;

async function executeRecall(
  params: RecallHandlerParams,
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext
): Promise<unknown> {
  const recallStartedAt = Date.now();
  const taskSurface = buildTaskSurface(request, params.generateId);
  const policyOverride = buildRecallPolicy(request, taskSurface.runtime_id, params.generateId());
  const recallResult = await runRecallService(params, request, context, taskSurface, policyOverride);
  const resultCandidates = selectRecallCandidates(recallResult, request.max_results);
  const { results, explainabilityPartial } = buildRecallResults(resultCandidates, policyOverride);
  const delivery = buildRecallDelivery(params, context, results, recallResult);
  await params.deps.trustStateRecorder.recordDelivery(delivery.record);
  runRecallAsyncSideEffects(params, request, context, delivery);
  await emitRecallDeliveredTelemetry(params, {
    deliveryId: delivery.deliveryId,
    query: request.query,
    pointerCount: delivery.deliveredObjectIds.length,
    latencyMs: Date.now() - recallStartedAt,
    context
  });
  return buildRecallResponse(delivery.deliveryId, results, resultCandidates.length, recallResult, policyOverride, explainabilityPartial);
}

function buildTaskSurface(request: SoulMemorySearchRequest, generateId: () => string) {
  return TaskObjectSurfaceSchema.parse({
    runtime_id: generateId(),
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "mcp_memory_tool",
    display_name: request.query,
    context_refs: []
  });
}

async function runRecallService(
  params: RecallHandlerParams,
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext,
  taskSurface: ReturnType<typeof TaskObjectSurfaceSchema.parse>,
  policyOverride: RecallPolicy
): Promise<RecallServiceResult> {
  return await params.deps.recallService.recall({
    taskSurface,
    workspaceId: context.workspaceId,
    strategy: "chat",
    runId: context.runId,
    policyOverride,
    timeFilter: buildRecallTimeFilter(request),
    hostContext: request.host_context,
    activeConstraintsCap: request.active_constraints_cap ?? null
  });
}

function selectRecallCandidates(recallResult: RecallServiceResult, maxResults: number) {
  const activeConstraintIds = new Set(
    recallResult.active_constraints.map((constraint) => constraint.object_id)
  );
  return recallResult.candidates
    .filter((candidate) => !activeConstraintIds.has(candidate.object_id))
    .slice(0, maxResults);
}

function buildRecallDelivery(
  params: RecallHandlerParams,
  context: RecallUsageToolCallContext,
  results: readonly RecallSearchResult[],
  recallResult: RecallServiceResult
) {
  const deliveryId = `delivery_${params.generateId()}`;
  const deliveredObjects = dedupeDeliveredObjectIdentities([
    ...results.map((result) => ({ object_id: result.object_id, object_kind: result.object_kind })),
    ...recallResult.active_constraints.map((constraint) => ({
      object_id: constraint.object_id,
      object_kind: constraint.object_kind
    }))
  ]);
  const deliveredObjectIds = uniqueObjectIds(deliveredObjects);
  return {
    deliveryId,
    deliveredObjectIds,
    record: {
      delivery_id: deliveryId,
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: deliveredObjectIds,
      delivered_objects: deliveredObjects,
      delivered_at: params.now()
    }
  };
}

function runRecallAsyncSideEffects(
  params: RecallHandlerParams,
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext,
  delivery: ReturnType<typeof buildRecallDelivery>
): void {
  scheduleAuditedAsyncSideEffect(
    accrueCoRecallPlasticity(params, delivery.deliveredObjectIds, context.workspaceId),
    recallPlasticityAuditOptions(params, context, delivery.deliveryId)
  );
  enqueueRecallExtractTask(params, request, context, delivery.deliveredObjectIds);
}

function recallPlasticityAuditOptions(
  params: RecallHandlerParams,
  context: RecallUsageToolCallContext,
  deliveryId: string
) {
  return {
    source: "mcp-memory.recall",
    operation: "co_recall_plasticity_accrual",
    subjectType: "context_delivery",
    subjectId: deliveryId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    warningCode: "ALAYA_CO_RECALL_PLASTICITY_FAILED",
    warningMessage: "[RecallUsage] co-recall plasticity side effect failed",
    eventLogRepo: params.deps.asyncSideEffectAudit?.eventLogRepo,
    runtimeNotifier: params.deps.asyncSideEffectAudit?.runtimeNotifier,
    now: params.now
  };
}

function buildRecallResponse(
  deliveryId: string,
  results: readonly RecallSearchResult[],
  totalCount: number,
  recallResult: RecallServiceResult,
  policyOverride: RecallPolicy,
  explainabilityPartial: boolean
): unknown {
  return SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    total_count: totalCount,
    strategy_mix: buildRecallStrategyMix(policyOverride, results),
    degradation_reason: resolveDegradationReason(recallResult, explainabilityPartial)
  });
}

export function createReportContextUsageHandler(params: Readonly<{
  readonly deps: RecallUsageHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
}>) {
  const { deps } = params;

  return async function reportContextUsage(
    request: SoulReportContextUsageRequest,
    context: RecallUsageToolCallContext
  ) {
    const reportedAt = params.now();
    validateUsageStateConsistency(request);
    const linkedDelivery = await deps.trustStateRecorder.findDeliveryById(request.delivery_id);
    await validateReportedRecallHits(deps, request, context.workspaceId, linkedDelivery);
    const usageState = resolveUsageState(request);
    const usedObjectIds = resolveUsedObjectIds(request);
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: usageState,
        used_object_ids: usedObjectIds,
        trust_mode: "automatic",
        ...(request.per_anchor_usage === undefined
          ? {}
          : { per_anchor_usage: request.per_anchor_usage }),
        reason: request.reason ?? null,
        reported_at: reportedAt
      },
      { expectedWorkspaceId: context.workspaceId }
    );
    await promoteRecallHitMemories(params, request, context, linkedDelivery, reportedAt);
    await maybeEmitCoUsage(params, linkedDelivery, usedObjectIds, request, context);
    enqueuePostTurnExtractTask(params, request, context, linkedDelivery);
    await emitContextUsageReportedTelemetry(params, {
      deliveryId: request.delivery_id,
      usageState,
      occurredAt: reportedAt,
      context,
      linkedDelivery
    });
    return SoulReportContextUsageResponseSchema.parse({
      delivery_id: request.delivery_id,
      status: "recorded"
    });
  };
}

function buildRecallTimeFilter(request: SoulMemorySearchRequest) {
  if (
    request.since === undefined &&
    request.until === undefined &&
    request.time_field === undefined
  ) {
    return undefined;
  }
  return {
    since: request.since ?? null,
    until: request.until ?? null,
    field: request.time_field ?? "created_at"
  } as const;
}

function buildRecallResults(
  resultCandidates: readonly Readonly<RecallCandidate>[],
  policyOverride: RecallPolicy
) {
  let usedTokens = 0;
  let explainabilityPartial = false;
  const results = resultCandidates.map((candidate, index) => {
    if (candidateHasPartialExplainability(candidate)) {
      explainabilityPartial = true;
    }
    const result = buildMemorySearchResult(candidate, policyOverride, index, usedTokens);
    usedTokens += candidate.token_estimate;
    return result;
  });
  return { results, explainabilityPartial };
}

function candidateHasPartialExplainability(candidate: Readonly<RecallCandidate>): boolean {
  return (
    candidate.selection_reason === undefined ||
    candidate.source_channels === undefined ||
    candidate.score_factors === undefined ||
    candidate.budget_state === undefined
  );
}

function resolveDegradationReason(
  recallResult: Readonly<{
    readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
  }>,
  explainabilityPartial: boolean
): SoulMemorySearchDegradationReason | "recall_explainability_partial" | null {
  return recallResult.degradation_reason ?? (explainabilityPartial ? "recall_explainability_partial" : null);
}

async function maybeEmitCoUsage(
  params: Readonly<{
    readonly deps: RecallUsageHandlerDependencies;
    readonly now: () => string;
    readonly warn: WarnPort;
  }>,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null,
  usedObjectIds: readonly string[],
  request: SoulReportContextUsageRequest,
  context: RecallUsageToolCallContext
): Promise<void> {
  if (linkedDelivery === null) {
    return;
  }
  await crossLinkRecalledMemories(
    params,
    usedObjectIds,
    linkedDelivery.workspace_id ?? context.workspaceId,
    linkedDelivery.run_id ?? context.runId ?? null
  );
  if (params.deps.pathRelationProposalService === undefined || usedObjectIds.length < 2) {
    return;
  }
  try {
    await params.deps.pathRelationProposalService.onCoUsage(
      usedObjectIds,
      linkedDelivery.workspace_id ?? context.workspaceId
    );
  } catch (err) {
    const workspaceId = linkedDelivery.workspace_id ?? context.workspaceId;
    await reportAsyncSideEffectFailure(
      {
        source: "mcp-memory.report_context_usage",
        operation: "path_relation_co_usage",
        subjectType: "context_delivery",
        subjectId: request.delivery_id,
        workspaceId,
        runId: linkedDelivery.run_id ?? context.runId ?? null,
        warningCode: "ALAYA_PATH_RELATION_CO_USAGE_FAILED",
        warningMessage: "[RecallUsage] path relation co-usage side effect failed",
        eventLogRepo: params.deps.asyncSideEffectAudit?.eventLogRepo,
        runtimeNotifier: params.deps.asyncSideEffectAudit?.runtimeNotifier,
        now: params.now
      },
      err
    );
  }
}

export function createGardenTaskPayloadFingerprint(
  input: Readonly<{
    readonly kind: string;
    readonly workspaceId: string;
    readonly role: string;
    readonly tier: string;
    readonly payloadJson: string;
  }>
): string {
  return `${input.kind}:${input.workspaceId}:${input.role}:${input.tier}:${input.payloadJson}`;
}
