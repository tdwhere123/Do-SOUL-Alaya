import {
  type AsyncSideEffectAuditEventLogPort,
  type AsyncSideEffectAuditNotifierPort,
  type EventPublisher
} from "@do-soul/alaya-core";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  ControlPlaneObjectKind,
  RetentionPolicy,
  SoulMemorySearchResponseSchema,
  SoulReportContextUsageResponseSchema,
  TaskObjectSurfaceSchema,
  UsageReportSchema,
  indexEntryCacheKey,
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
  type UsageProofRecord,
  type UsageReport
} from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput, GardenTaskRow } from "@do-soul/alaya-storage";
import { enqueuePostTurnExtractTask } from "../garden-task/post-turn-extract-queue.js";
import {
  encodeIndexResults,
  sourceMetadataForRecallResult,
  frameEncodedIndex,
  resolveMcpDegradationReason,
  selectRecallMcpHonestyDiagnostics,
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
      readonly pageBudget?: number;
      readonly queryText?: string;
      readonly interpretationClock?: string;
      readonly since?: string;
      readonly until?: string;
      readonly continuation?: import("@do-soul/alaya-protocol").Continuation | null;
      readonly enumeration_policy?: import("@do-soul/alaya-protocol").EnumerationPolicy;
      readonly result_kind_view?: import("@do-soul/alaya-protocol").ResultKindView;
      readonly interpretation_proposal?: import("@do-soul/alaya-protocol").QueryInterpretationProposal;
      readonly payload_continuation?: import("@do-soul/alaya-protocol").PayloadContinuationRequest;
    }): Promise<Readonly<{
      readonly candidates: readonly Readonly<RecallCandidate>[];
      readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
      readonly active_constraints_count: number | null;
      readonly active_constraints_completeness?: "complete" | "incomplete";
      readonly total_scanned: number;
      readonly coarse_filter_count: number;
      readonly fine_assessment_count: number;
      readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
      readonly diagnostics?: RecallMcpHonestyDiagnostics | null;
      readonly index: import("@do-soul/alaya-protocol").InformationIndex;
      readonly provider_calls?: 0;
      readonly garden_enqueue?: 0;
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
  readonly fieldSource?: {
    findRecordById(
      workspaceId: string,
      recordId: string
    ): Promise<Readonly<{
      readonly workspace_id: string;
      readonly record_id: string;
      readonly source_version: string;
      readonly content_digest: string;
      readonly evidence_object_id: string | null;
      readonly source_body: string | null;
    }> | null> | Readonly<{
      readonly workspace_id: string;
      readonly record_id: string;
      readonly source_version: string;
      readonly content_digest: string;
      readonly evidence_object_id: string | null;
      readonly source_body: string | null;
    }> | null;
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
type RecallSearchResult = SoulMemorySearchResponse["results"][number];

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
  const encoded = encodeRecallHandlerResults(recallResult, policyOverride);
  const delivery = buildRecallDelivery(params, context, encoded.results, { ...recallResult, index: encoded.index });
  await params.deps.trustStateRecorder.recordDelivery(delivery.record);
  await emitRecallDeliveredTelemetry(params, {
    deliveryId: delivery.deliveryId,
    query: request.query,
    pointerCount: delivery.deliveredObjectIds.length,
    latencyMs: Date.now() - recallStartedAt,
    context
  });
  return buildRecallResponse(
    delivery.deliveryId,
    encoded.results,
    encoded.results.length,
    { ...recallResult, index: encoded.index },
    encoded.explainabilityPartial
  );
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

function encodeRecallHandlerResults(recallResult: RecallServiceResult, policy: RecallPolicy) {
  const index = recallResult.index;
  if (index === undefined) throw new Error("conditional-field Recall requires an authoritative index");
  const previews = new Map(
    index.entries.map((entry, offset) => [
      indexEntryCacheKey(entry),
      recallResult.candidates[offset]?.content_preview ?? "[payload omitted]"
    ] as const)
  );
  const maxTotalTokens = policy.fine_assessment.budgets.max_total_tokens;
  const metadata = sourceMetadataForRecallResult(recallResult);
  const results = encodeIndexResults(index, previews, maxTotalTokens, metadata);
  return {
    index: frameEncodedIndex(index, results),
    results,
    explainabilityPartial: false
  };
}

function buildRecallDelivery(
  params: RecallHandlerParams,
  context: RecallUsageToolCallContext,
  results: readonly RecallSearchResult[],
  recallResult: RecallServiceResult
) {
  const deliveryId = `delivery_${params.generateId()}`;
  const deliveredObjects = dedupeDeliveredObjectIdentities([
    ...results.map((result) => ({
      ...(result.object_id === undefined ? {} : { object_id: result.object_id }),
      object_kind: result.object_kind,
      target: result.target
    })),
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
      witness_exposures: witnessExposures(recallResult.index),
      delivered_at: params.now()
    }
  };
}

function buildRecallResponse(
  deliveryId: string,
  results: readonly RecallSearchResult[],
  totalCount: number,
  recallResult: RecallServiceResult,
  explainabilityPartial: boolean
): SoulMemorySearchResponse {
  const honestyDiagnostics = selectRecallMcpHonestyDiagnostics(recallResult.diagnostics);
  return SoulMemorySearchResponseSchema.parse({
    delivery_id: deliveryId,
    protocol_version: 1,
    results,
    active_constraints: recallResult.active_constraints,
    active_constraints_count: recallResult.active_constraints_count,
    ...(recallResult.active_constraints_completeness === undefined ? {} : {
      active_constraints_completeness: recallResult.active_constraints_completeness
    }),
    total_count: totalCount,
    degradation_reason: resolveMcpDegradationReason(
      {
        degradation_reason: recallResult.degradation_reason,
        diagnostics: honestyDiagnostics
      },
      explainabilityPartial
    ),
    index: recallResult.index,
    ...(recallResult.index.order_status === undefined ? {} : { order_status: recallResult.index.order_status }),
    ...(recallResult.index.page_purpose === undefined ? {} : { page_purpose: recallResult.index.page_purpose }),
    ...(recallResult.index.product_updates === undefined
      ? {}
      : { product_updates: recallResult.index.product_updates })
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
    // Discarded attribution is not a second usage write; recordUsage already owns the proof.
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: usageState,
        used_object_ids: usedObjectIds,
        ...(request.witness_reports === undefined ? {} : { witness_reports: request.witness_reports }),
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

export function usageReportsFromContextUsage(
  request: SoulReportContextUsageRequest
): readonly UsageReport[] {
  const reportedUse = request.usage_state === "used"
    ? "used"
    : request.usage_state === "skipped"
      ? "unused"
      : "unknown";
  const reports: UsageReport[] = [
    UsageReportSchema.parse({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      grain: "output",
      exposure: "exposed",
      reported_use: reportedUse,
      output_id: request.delivery_id
    })
  ];
  for (const objectId of request.used_object_ids ?? []) {
    reports.push(UsageReportSchema.parse({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      grain: "object",
      exposure: "exposed",
      reported_use: "used",
      object_id: objectId,
      output_id: request.delivery_id
    }));
  }
  return [...reports, ...(request.witness_reports ?? [])];
}

function witnessExposures(index: RecallServiceResult["index"]): readonly UsageReport[] {
  if (index?.interpretation_id === undefined || index.as_of === undefined) return [];
  const forest = new Map((index.explanations ?? []).map((node) => [node.derivation_id, node]));
  const roots = new Set(index.entries.flatMap((entry) => entry.explanation_ids));
  const pending = [...roots];
  const visited = new Set<string>();
  const witnesses = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = forest.get(id);
    if (node === undefined) continue;
    witnesses.add(node.witness_id ?? node.derivation_id);
    pending.push(...node.children);
  }
  return [...witnesses].map((witness_id) => UsageReportSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, grain: "witness", exposure: "exposed",
    reported_use: "missing", witness_id, query_id: index.query_id, snapshot_id: index.snapshot_id,
    interpretation_id: index.interpretation_id, as_of: index.as_of
  }));
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
