import { createHash } from "node:crypto";
import {
  ControlPlaneObjectKind,
  EdgeProposalTriggerSource,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  MemoryDimensionSchema,
  MemoryGovernanceEventType,
  MemoryGraphEdgeType,
  RecallContextEventType,
  RetentionPolicy,
  ScopeClassSchema,
  SoulContextUsageReportedPayloadSchema,
  SoulMemorySearchResponseSchema,
  SoulMemoryTierPromotedPayloadSchema,
  SoulRecallDeliveredPayloadSchema,
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
import type {
  GardenTaskEnqueueInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import type { GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import { buildMemorySearchResult, buildRecallStrategyMix } from "./recall-result.js";
import {
  enqueuePostTurnExtractTask,
  enqueueRecallExtractTask
} from "./post-turn-extract-queue.js";

const RECALL_HIT_ACTIVATION_BUMP = 0.05;
// Bounds the fan-out per `report_context_usage(used)` call. With N=8 the
// ordered pairs cap at 56 cross-link proposals; the edge-proposal/path
// candidate intake deduplicates on (source, target, edge_type), so repeated
// reports of the same set are idempotent.
const MAX_CROSS_LINK_FANOUT = 8;
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

type WarnPort = (message: string, meta: Record<string, unknown>) => void;

class ContextUsageValidationError extends Error {
  public readonly code: "VALIDATION";

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageValidationError";
    this.code = "VALIDATION";
  }
}

class ContextUsageNotFoundError extends Error {
  public readonly code: "NOT_FOUND";

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageNotFoundError";
    this.code = "NOT_FOUND";
  }
}

class RecallHitTierPromotionCasMiss extends Error {}

export function createRecallHandler(params: Readonly<{
  readonly deps: RecallUsageHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
  readonly generateId: () => string;
}>) {
  const { deps } = params;

  return async function recall(
    request: SoulMemorySearchRequest,
    context: RecallUsageToolCallContext
  ) {
    const recallStartedAt = Date.now();
    const taskSurface = TaskObjectSurfaceSchema.parse({
      runtime_id: params.generateId(),
      object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      task_surface_ref: null,
      expires_at: null,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      surface_kind: "mcp_memory_tool",
      display_name: request.query,
      context_refs: []
    });
    const policyOverride = buildRecallPolicy(request, taskSurface.runtime_id, params.generateId());
    const timeFilter =
      request.since !== undefined || request.until !== undefined || request.time_field !== undefined
        ? {
            since: request.since ?? null,
            until: request.until ?? null,
            field: request.time_field ?? "created_at"
          }
        : undefined;
    const recallResult = await deps.recallService.recall({
      taskSurface,
      workspaceId: context.workspaceId,
      strategy: "chat",
      runId: context.runId,
      policyOverride,
      timeFilter,
      hostContext: request.host_context,
      activeConstraintsCap: request.active_constraints_cap ?? null
    });
    let usedTokens = 0;
    let explainabilityPartial = false;
    const activeConstraintIds = new Set(recallResult.active_constraints.map((constraint) => constraint.object_id));
    const resultCandidates = recallResult.candidates
      .filter((candidate) => !activeConstraintIds.has(candidate.object_id))
      .slice(0, request.max_results);
    const results = resultCandidates.map((candidate, index) => {
      if (
        candidate.selection_reason === undefined ||
        candidate.source_channels === undefined ||
        candidate.score_factors === undefined ||
        candidate.budget_state === undefined
      ) {
        explainabilityPartial = true;
      }
      const result = buildMemorySearchResult(candidate, policyOverride, index, usedTokens);
      usedTokens += candidate.token_estimate;
      return result;
    });
    const deliveryId = `delivery_${params.generateId()}`;
    const deliveredObjects = dedupeDeliveredObjectIdentities([
      ...results.map((result) => ({
        object_id: result.object_id,
        object_kind: result.object_kind
      })),
      ...recallResult.active_constraints.map((constraint) => ({
        object_id: constraint.object_id,
        object_kind: constraint.object_kind
      }))
    ]);
    const deliveredObjectIds = uniqueObjectIds(deliveredObjects);
    await deps.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: deliveredObjectIds,
      delivered_objects: deliveredObjects,
      delivered_at: params.now()
    });

    void accrueCoRecallPlasticity(params, deliveredObjectIds, context.workspaceId).catch((err) => {
      params.warn("co-recall plasticity fire-and-forget failed", {
        workspace_id: context.workspaceId,
        error: err instanceof Error ? err.message : String(err)
      });
    });

    enqueueRecallExtractTask(params, request, context, deliveredObjectIds);

    await emitRecallDeliveredTelemetry(params, {
      deliveryId,
      query: request.query,
      pointerCount: deliveredObjectIds.length,
      latencyMs: Date.now() - recallStartedAt,
      context
    });

    const degradationReason =
      recallResult.degradation_reason ?? (explainabilityPartial ? "recall_explainability_partial" : null);

    return SoulMemorySearchResponseSchema.parse({
      delivery_id: deliveryId,
      results,
      active_constraints: recallResult.active_constraints,
      active_constraints_count: recallResult.active_constraints_count,
      total_count: resultCandidates.length,
      strategy_mix: buildRecallStrategyMix(policyOverride, results),
      degradation_reason: degradationReason
    });
  };
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
    if (linkedDelivery !== null) {
      await crossLinkRecalledMemories(
        params,
        usedObjectIds,
        linkedDelivery.workspace_id ?? context.workspaceId,
        linkedDelivery.run_id ?? context.runId ?? null
      );
      if (deps.pathRelationProposalService !== undefined && usedObjectIds.length >= 2) {
        try {
          await deps.pathRelationProposalService.onCoUsage(
            usedObjectIds,
            linkedDelivery.workspace_id ?? context.workspaceId
          );
        } catch (err) {
          params.warn("path relation propose failed", {
            workspace_id: linkedDelivery.workspace_id ?? context.workspaceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
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

async function accrueCoRecallPlasticity(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly warn: WarnPort }>,
  deliveredObjectIds: readonly string[],
  workspaceId: string
): Promise<void> {
  const { deps } = params;
  if (deps.pathRelationProposalService === undefined || deliveredObjectIds.length < 2) {
    return;
  }
  try {
    const allowedPairKeys =
      deps.coRecallCoherenceGate === undefined
        ? new Set<string>()
        : await deps.coRecallCoherenceGate.coherentPairKeys(workspaceId, deliveredObjectIds);
    if (allowedPairKeys.size === 0) {
      return;
    }
    await deps.pathRelationProposalService.onCoRecall(
      deliveredObjectIds,
      workspaceId,
      allowedPairKeys
    );
  } catch (err) {
    params.warn("co-recall plasticity accrual failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function emitRecallDeliveredTelemetry(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly now: () => string }>,
  input: {
    readonly deliveryId: string;
    readonly query: string;
    readonly pointerCount: number;
    readonly latencyMs: number;
    readonly context: RecallUsageToolCallContext;
  }
): Promise<void> {
  if (params.deps.eventPublisher === undefined) {
    return;
  }
  const occurredAt = params.now();
  const queryHash = createHash("sha256").update(input.query).digest("hex").slice(0, 16);
  const event = {
    event_type: RecallContextEventType.SOUL_RECALL_DELIVERED,
    entity_type: "context_delivery",
    entity_id: input.deliveryId,
    workspace_id: input.context.workspaceId,
    run_id: input.context.runId,
    caused_by: input.context.agentTarget,
    payload_json: SoulRecallDeliveredPayloadSchema.parse({
      delivery_id: input.deliveryId,
      session_id: input.context.sessionId,
      run_id: input.context.runId,
      agent_target: input.context.agentTarget,
      query_hash: queryHash,
      pointer_count: input.pointerCount,
      latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
      workspace_id: input.context.workspaceId,
      occurred_at: occurredAt
    })
  } as const;
  try {
    await params.deps.eventPublisher.appendManyWithMutation([event], () => undefined);
  } catch {
    // INVARIANT: telemetry append never throws to the MCP caller.
  }
}

async function emitContextUsageReportedTelemetry(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies }>,
  input: {
    readonly deliveryId: string;
    readonly usageState: SoulReportContextUsageRequest["usage_state"];
    readonly occurredAt: string;
    readonly context: RecallUsageToolCallContext;
    readonly linkedDelivery: Readonly<ContextDeliveryRecord> | null;
  }
): Promise<void> {
  if (params.deps.eventPublisher === undefined) {
    return;
  }
  const attributedRunId = input.linkedDelivery?.run_id ?? input.context.runId;
  const attributedAgentTarget = input.linkedDelivery?.agent_target ?? input.context.agentTarget;
  const attributedWorkspaceId = input.linkedDelivery?.workspace_id ?? input.context.workspaceId;
  const event = {
    event_type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
    entity_type: "context_delivery",
    entity_id: input.deliveryId,
    workspace_id: attributedWorkspaceId,
    run_id: attributedRunId,
    caused_by: attributedAgentTarget,
    payload_json: SoulContextUsageReportedPayloadSchema.parse({
      delivery_id: input.deliveryId,
      session_id: input.context.sessionId,
      run_id: attributedRunId,
      agent_target: attributedAgentTarget,
      usage_state: input.usageState,
      workspace_id: attributedWorkspaceId,
      occurred_at: input.occurredAt
    })
  } as const;
  try {
    await params.deps.eventPublisher.appendManyWithMutation([event], () => undefined);
  } catch {
    // INVARIANT: telemetry append never throws to the MCP caller.
  }
}

function resolveReportSideEffectAttribution(
  linkedDelivery: Readonly<ContextDeliveryRecord> | null,
  context: RecallUsageToolCallContext
): {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
} | null {
  if (linkedDelivery === null) {
    return null;
  }

  return {
    workspaceId: linkedDelivery.workspace_id ?? context.workspaceId,
    runId: linkedDelivery.run_id,
    agentTarget: linkedDelivery.agent_target
  };
}

async function validateReportedRecallHits(
  deps: RecallUsageHandlerDependencies,
  request: SoulReportContextUsageRequest,
  workspaceId: string,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null
): Promise<void> {
  const usedObjectIds = resolveUsedObjectIds(request);
  if (usedObjectIds.length === 0) {
    return;
  }

  if (linkedDelivery !== null) {
    const deliveredIds = new Set(linkedDelivery.delivered_object_ids);
    for (const objectId of usedObjectIds) {
      if (!deliveredIds.has(objectId)) {
        throw new ContextUsageValidationError(
          `used_object_ids include ${objectId}, which was not part of delivery ${request.delivery_id}.`
        );
      }
    }
  }

  if (deps.memoryService.findByIdsScoped !== undefined) {
    const memories = await deps.memoryService.findByIdsScoped(usedObjectIds, workspaceId);
    const foundIds = new Set(memories.map((memory) => memory.object_id));
    for (const objectId of usedObjectIds) {
      if (!foundIds.has(objectId)) {
        throw new ContextUsageNotFoundError(`Memory entry ${objectId} was not found.`);
      }
    }
    return;
  }

  await Promise.all(usedObjectIds.map(async (objectId) => {
    const memory = await deps.memoryService.findByIdScoped(objectId, workspaceId);
    if (memory === null) {
      throw new ContextUsageNotFoundError(`Memory entry ${objectId} was not found.`);
    }
  }));
}

async function refreshReportedRecallHits(
  deps: RecallUsageHandlerDependencies,
  request: SoulReportContextUsageRequest,
  workspaceId: string,
  reportedAt: string
): Promise<void> {
  const usedObjectIds = resolveUsedObjectIds(request);
  if (usedObjectIds.length === 0) {
    return;
  }

  await Promise.all(
    usedObjectIds.map(async (objectId) => {
      await refreshScopedRecallUsage(deps, objectId, workspaceId, reportedAt);
    })
  );
}

async function refreshScopedRecallUsage(
  deps: RecallUsageHandlerDependencies,
  objectId: string,
  workspaceId: string,
  reportedAt: string
): Promise<void> {
  if (deps.memoryService.updateScoped === undefined) {
    return;
  }
  await deps.memoryService.updateScoped(
    objectId,
    workspaceId,
    {
      storage_tier: StorageTier.HOT,
      last_used_at: reportedAt,
      last_hit_at: reportedAt
    },
    "recall_usage_reported"
  );
}

async function crossLinkRecalledMemories(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly warn: WarnPort }>,
  usedObjectIds: readonly string[],
  workspaceId: string,
  runId: string | null
): Promise<void> {
  if (params.deps.graphEdgePort === undefined || usedObjectIds.length < 2) {
    return;
  }

  if (usedObjectIds.length > MAX_CROSS_LINK_FANOUT) {
    params.warn("mcp-memory-tool-handler: cross-link truncated to fanout cap", {
      usedObjectCount: usedObjectIds.length,
      truncatedTo: MAX_CROSS_LINK_FANOUT,
      droppedCount: usedObjectIds.length - MAX_CROSS_LINK_FANOUT
    });
  }
  const targets = usedObjectIds.slice(0, MAX_CROSS_LINK_FANOUT);

  for (const source of targets) {
    for (const target of targets) {
      if (source === target) {
        continue;
      }
      try {
        await params.deps.graphEdgePort.createEdge({
          sourceMemoryId: source,
          targetMemoryId: target,
          edgeType: MemoryGraphEdgeType.RECALLS,
          workspaceId,
          runId,
          triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
          confidence: 0.5,
          reason: "report_context_usage used-memory cross-link"
        });
      } catch (err) {
        params.warn("mcp-memory-tool-handler: recalls edge creation failed", {
          sourceMemoryId: source,
          targetMemoryId: target,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
}

async function promoteRecallHitMemories(
  params: Readonly<{
    readonly deps: RecallUsageHandlerDependencies;
    readonly warn: WarnPort;
  }>,
  request: SoulReportContextUsageRequest,
  context: RecallUsageToolCallContext,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null,
  reportedAt: string
): Promise<void> {
  const attribution = resolveReportSideEffectAttribution(linkedDelivery, context);
  if (attribution === null) {
    return;
  }

  if (params.deps.eventPublisher === undefined || params.deps.memoryEntryRepo === undefined) {
    await refreshReportedRecallHits(params.deps, request, attribution.workspaceId, reportedAt);
    return;
  }

  const usedObjectIds = resolveUsedObjectIds(request);
  const currentByObjectId =
    params.deps.memoryService.findByIdsScoped === undefined
      ? null
      : new Map(
          (
            await params.deps.memoryService.findByIdsScoped(
              usedObjectIds,
              attribution.workspaceId
            )
          ).map((entry) => [entry.object_id, entry] as const)
        );
  for (const objectId of usedObjectIds) {
    const current =
      currentByObjectId?.get(objectId) ??
      await params.deps.memoryService.findByIdScoped(objectId, attribution.workspaceId);
    if (current === null) {
      continue;
    }
    const isReuseHit = current.last_hit_at !== null && current.last_hit_at !== undefined;
    if (current.storage_tier === StorageTier.HOT) {
      await refreshScopedRecallUsage(
        params.deps,
        objectId,
        attribution.workspaceId,
        reportedAt
      );
      await maybeEmitReuseGainKarma(params, isReuseHit, objectId, attribution.workspaceId, attribution.runId);
      continue;
    }

    const occurredAt = reportedAt;
    const event = {
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
      entity_type: "memory_entry",
      entity_id: current.object_id,
      workspace_id: attribution.workspaceId,
      run_id: attribution.runId,
      caused_by: attribution.agentTarget,
      payload_json: SoulMemoryTierPromotedPayloadSchema.parse({
        object_id: current.object_id,
        object_kind: current.object_kind,
        workspace_id: attribution.workspaceId,
        run_id: attribution.runId,
        from_tier: current.storage_tier,
        to_tier: StorageTier.HOT,
        reason: "recall_hit",
        occurred_at: occurredAt
      })
    } as const;

    try {
      await params.deps.eventPublisher.appendManyWithMutation([event], () => {
        const updated = params.deps.memoryEntryRepo?.updateTier({
          objectId: current.object_id,
          workspaceId: attribution.workspaceId,
          fromTier: current.storage_tier,
          toTier: StorageTier.HOT,
          updatedAt: occurredAt,
          expectedUpdatedAt: current.updated_at,
          activationBump: RECALL_HIT_ACTIVATION_BUMP,
          lastUsedAt: occurredAt,
          lastHitAt: occurredAt
        });
        if (updated === null || updated === undefined) {
          throw new RecallHitTierPromotionCasMiss();
        }
        return updated;
      });
    } catch (error) {
      if (error instanceof RecallHitTierPromotionCasMiss) {
        continue;
      }
      throw error;
    }
    await maybeEmitReuseGainKarma(params, isReuseHit, objectId, attribution.workspaceId, attribution.runId);
  }
}

async function maybeEmitReuseGainKarma(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly warn: WarnPort }>,
  isReuseHit: boolean,
  objectId: string,
  workspaceId: string,
  runId: string | null
): Promise<void> {
  if (!isReuseHit || params.deps.dynamicsService === undefined) {
    return;
  }
  try {
    await params.deps.dynamicsService.emitKarmaEvent({
      kind: "reuse_gain",
      objectId,
      workspaceId,
      runId
    });
  } catch (error) {
    params.warn("reuse_gain karma emit failed", {
      memory_object_id: objectId,
      workspace_id: workspaceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function resolveUsedObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    const usedIds = request.delivered_objects
      .filter(
        (object) =>
          object.usage_status === "used" &&
          resolveReportObjectKind(object) === "memory_entry"
      )
      .map((object) => object.object_id);
    return Object.freeze(Array.from(new Set(usedIds)));
  }
  if (request.usage_state === "used") {
    return Object.freeze(Array.from(new Set(request.used_object_ids ?? [])));
  }
  return Object.freeze([]);
}

function resolveUsageState(request: SoulReportContextUsageRequest): SoulReportContextUsageRequest["usage_state"] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    return deriveDeliveredObjectsUsageState(request.delivered_objects);
  }
  return request.usage_state;
}

function validateUsageStateConsistency(request: SoulReportContextUsageRequest): void {
  const deliveredObjects = request.delivered_objects;
  if (deliveredObjects !== undefined && deliveredObjects.length > 0) {
    const derivedUsageState = deriveDeliveredObjectsUsageState(deliveredObjects);
    if (request.usage_state !== derivedUsageState) {
      throw new ContextUsageValidationError(
        `usage_state ${request.usage_state} contradicts delivered_objects aggregate usage_state ${derivedUsageState}.`
      );
    }
    if (request.used_object_ids !== undefined) {
      const reportedIds = [...new Set(request.used_object_ids)].sort();
      const deliveredUsedIds = [...new Set(
        deliveredObjects
          .filter(
            (object) =>
              object.usage_status === "used" &&
              resolveReportObjectKind(object) === "memory_entry"
          )
          .map((object) => object.object_id)
      )].sort();
      if (reportedIds.join("\0") !== deliveredUsedIds.join("\0")) {
        throw new ContextUsageValidationError("used_object_ids contradict delivered_objects usage_status values.");
      }
    }
    return;
  }

  if (request.usage_state !== "used" && (request.used_object_ids?.length ?? 0) > 0) {
    throw new ContextUsageValidationError("used_object_ids can only be supplied when usage_state is used.");
  }
}

function deriveDeliveredObjectsUsageState(
  deliveredObjects: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>
): SoulReportContextUsageRequest["usage_state"] {
  if (deliveredObjects.some((object) => object.usage_status === "used")) {
    return "used";
  }
  if (deliveredObjects.some((object) => object.usage_status === "skipped")) {
    return "skipped";
  }
  return "not_applicable";
}

function resolveReportObjectKind(
  object: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>[number]
): string {
  return object.object_kind ?? "memory_entry";
}

function dedupeDeliveredObjectIdentities(
  objects: readonly { readonly object_id: string; readonly object_kind: string }[]
): readonly { readonly object_id: string; readonly object_kind: string }[] {
  const seen = new Set<string>();
  const result: Array<{ readonly object_id: string; readonly object_kind: string }> = [];
  for (const object of objects) {
    const key = `${object.object_kind}\0${object.object_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(object);
  }
  return Object.freeze(result);
}

function uniqueObjectIds(
  objects: readonly { readonly object_id: string }[]
): readonly string[] {
  return Object.freeze([...new Set(objects.map((object) => object.object_id))]);
}

function buildRecallPolicy(
  request: SoulMemorySearchRequest,
  taskSurfaceId: string,
  policyId: string
): RecallPolicy {
  const maxResults = Math.max(request.max_results, 1);
  const coarseCandidateLimit = resolveRecallCoarseCandidateLimit(maxResults);
  const keywordCandidateLimit = resolveRecallKeywordCandidateLimit(maxResults, coarseCandidateLimit);

  return {
    runtime_id: policyId,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceId,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: request.scope_class === null ? null : [ScopeClassSchema.parse(request.scope_class)],
        dimension_filter: request.dimension === null ? null : [MemoryDimensionSchema.parse(request.dimension)],
        domain_tag_filter: request.domain_tags
      },
      precomputed_rank: {
        max_candidates: coarseCandidateLimit,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: keywordCandidateLimit,
        embedding_enabled: true
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: maxResults,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

function resolveRecallCoarseCandidateLimit(maxResults: number): number {
  return Math.min(Math.max(maxResults * 10, maxResults), 1000);
}

function resolveRecallKeywordCandidateLimit(maxResults: number, coarseCandidateLimit: number): number {
  return Math.min(Math.max(coarseCandidateLimit, maxResults * 10, 1), 1000);
}
