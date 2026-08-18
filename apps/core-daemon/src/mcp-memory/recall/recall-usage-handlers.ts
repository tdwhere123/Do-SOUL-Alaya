import {
  type AsyncSideEffectAuditEventLogPort,
  type AsyncSideEffectAuditNotifierPort,
  type EventPublisher
} from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  SoulReportContextUsageResponseSchema,
  TaskObjectSurfaceSchema,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type SoulMemorySearchDegradationReason,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse,
  type SoulRecallHostContext,
  type SoulReportContextUsageRequest,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput, GardenTaskRow } from "@do-soul/alaya-storage";
import { enqueuePostTurnExtractTask, enqueueRecallExtractTask } from "../garden-task/post-turn-extract-queue.js";
import {
  buildMemorySearchResult,
  buildRecallStrategyMix,
  resolveMcpDegradationReason,
  type RecallMcpHonestyDiagnostics
} from "./recall-result.js";
import { buildRecallPolicy, dedupeDeliveredObjectIdentities, uniqueObjectIds } from "./recall-usage-recall-support.js";
import { runProductionBoundRecall } from "./recall-bound-service.js";
import {
  emitContextUsageReportedTelemetry,
  emitRecallDeliveredTelemetry
} from "./recall-usage-telemetry.js";
import {
  resolveUsageState,
  resolveUsedObjectIdentities,
  resolveUsedObjectIds,
  validateReportedRecallHits,
  validateUsageStateConsistency
} from "./recall-usage-support.js";

export interface RecallUsageToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly sessionId: string;
  readonly surfaceId?: string | null;
}

export interface RecallUsageHandlerDependencies {
  readonly eventPublisher?: Pick<EventPublisher, "appendManyWithMutation">;
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
      readonly diagnostics?: RecallMcpHonestyDiagnostics | null;
    }>>;
  };
  readonly trustStateRecorder: {
    recordDelivery(input: Omit<ContextDeliveryRecord, "audit_event_id">): Promise<ContextDeliveryRecord>;
    recordUsage(
      input: Omit<UsageProofRecord, "audit_event_id">,
      options?: Readonly<{
        readonly expectedWorkspaceId?: string;
        readonly expectedAgentTarget?: string;
        readonly expectedRunId?: string;
      }>
    ): Promise<UsageProofRecord>;
    findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
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
  };
  readonly evidenceService?: {
    findByIdScoped?(
      objectId: string,
      workspaceId: string
    ): Promise<Readonly<{
      readonly object_id: string;
      readonly object_kind: string;
      readonly workspace_id: string;
      readonly lifecycle_state: string;
      readonly evidence_health_state: string;
    }> | null>;
  };
  readonly asyncSideEffectAudit?: {
    readonly eventLogRepo: AsyncSideEffectAuditEventLogPort;
    readonly runtimeNotifier?: AsyncSideEffectAuditNotifierPort;
  };
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
): Promise<SoulMemorySearchResponse> {
  const recallStartedAt = Date.now();
  const taskSurface = buildTaskSurface(request, params.generateId);
  const policyOverride = buildRecallPolicy(request, taskSurface.runtime_id, params.generateId());
  const recallResult = await runProductionBoundRecall({
    deps: params.deps,
    request,
    context,
    taskSurface,
    policyOverride
  });
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
  const deliveredMemoryObjectIds = uniqueObjectIds(
    deliveredObjects.filter((object) => object.object_kind === "memory_entry")
  );
  return {
    deliveryId,
    deliveredObjectIds,
    deliveredMemoryObjectIds,
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
  enqueueRecallExtractTask(params, request, context, delivery.deliveredMemoryObjectIds);
}

function buildRecallResponse(
  deliveryId: string,
  results: readonly RecallSearchResult[],
  totalCount: number,
  recallResult: RecallServiceResult,
  policyOverride: RecallPolicy,
  explainabilityPartial: boolean
): SoulMemorySearchResponse {
  return SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    total_count: totalCount,
    strategy_mix: buildRecallStrategyMix(policyOverride, results, recallResult.diagnostics),
    degradation_reason: resolveMcpDegradationReason(recallResult, explainabilityPartial)
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
    const usedObjects = resolveUsedObjectIdentities(request);
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: usageState,
        used_object_ids: usedObjectIds,
        ...(request.delivered_objects === undefined || request.delivered_objects.length === 0
          ? {}
          : { used_objects: usedObjects }),
        trust_mode: "automatic",
        ...(request.per_anchor_usage === undefined
          ? {}
          : { per_anchor_usage: request.per_anchor_usage }),
        reason: request.reason ?? null,
        reported_at: reportedAt
      },
      {
        expectedWorkspaceId: context.workspaceId,
        expectedAgentTarget: context.agentTarget,
        expectedRunId: context.runId ?? context.sessionId
      }
    );
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
