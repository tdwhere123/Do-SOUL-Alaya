import {
  EdgeProposalTriggerSource,
  MemoryGovernanceEventType,
  MemoryGraphEdgeType,
  SoulMemoryTierPromotedPayloadSchema,
  StorageTier,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext,
  WarnPort
} from "./recall-usage-handlers.js";

const RECALL_HIT_ACTIVATION_BUMP = 0.05;
const MAX_CROSS_LINK_FANOUT = 8;

export class ContextUsageValidationError extends Error {
  public readonly code = "VALIDATION" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageValidationError";
  }
}

export class ContextUsageNotFoundError extends Error {
  public readonly code = "NOT_FOUND" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageNotFoundError";
  }
}

export class RecallHitTierPromotionCasMiss extends Error {}

export async function accrueCoRecallPlasticity(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly warn: WarnPort }>,
  deliveredObjectIds: readonly string[],
  workspaceId: string
): Promise<void> {
  const { deps } = params;
  if (deps.pathRelationProposalService === undefined || deliveredObjectIds.length < 2) {
    return;
  }
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
}

export async function validateReportedRecallHits(
  deps: RecallUsageHandlerDependencies,
  request: SoulReportContextUsageRequest,
  workspaceId: string,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null
): Promise<void> {
  const usedObjectIds = resolveUsedObjectIds(request);
  if (usedObjectIds.length === 0) {
    return;
  }
  validateUsedObjectsBelongToDelivery(request, linkedDelivery, usedObjectIds);

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

  await Promise.all(
    usedObjectIds.map(async (objectId) => {
      const memory = await deps.memoryService.findByIdScoped(objectId, workspaceId);
      if (memory === null) {
        throw new ContextUsageNotFoundError(`Memory entry ${objectId} was not found.`);
      }
    })
  );
}

export async function crossLinkRecalledMemories(
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

export async function promoteRecallHitMemories(
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
  const currentByObjectId = await resolveCurrentUsedMemories(
    params.deps,
    usedObjectIds,
    attribution.workspaceId
  );
  for (const objectId of usedObjectIds) {
    const current =
      currentByObjectId?.get(objectId) ??
      await params.deps.memoryService.findByIdScoped(objectId, attribution.workspaceId);
    if (current === null) {
      continue;
    }
    await promoteSingleRecallHit(
      params,
      current,
      objectId,
      attribution.workspaceId,
      attribution.runId,
      attribution.agentTarget,
      reportedAt
    );
  }
}

export function resolveUsedObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
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

export function resolveUsageState(
  request: SoulReportContextUsageRequest
): SoulReportContextUsageRequest["usage_state"] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    return deriveDeliveredObjectsUsageState(request.delivered_objects);
  }
  return request.usage_state;
}

export function validateUsageStateConsistency(request: SoulReportContextUsageRequest): void {
  const deliveredObjects = request.delivered_objects;
  if (deliveredObjects !== undefined && deliveredObjects.length > 0) {
    const derivedUsageState = deriveDeliveredObjectsUsageState(deliveredObjects);
    if (request.usage_state !== derivedUsageState) {
      throw new ContextUsageValidationError(
        `usage_state ${request.usage_state} contradicts delivered_objects aggregate usage_state ${derivedUsageState}.`
      );
    }
    validateUsedIdsMatchDeliveredObjects(request, deliveredObjects);
    return;
  }
  if (request.usage_state !== "used" && (request.used_object_ids?.length ?? 0) > 0) {
    throw new ContextUsageValidationError("used_object_ids can only be supplied when usage_state is used.");
  }
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

async function resolveCurrentUsedMemories(
  deps: RecallUsageHandlerDependencies,
  usedObjectIds: readonly string[],
  workspaceId: string
): Promise<Map<string, Readonly<MemoryRecord>> | null> {
  if (deps.memoryService.findByIdsScoped === undefined) {
    return null;
  }
  return new Map(
    (
      await deps.memoryService.findByIdsScoped(usedObjectIds, workspaceId)
    ).map((entry) => [entry.object_id, entry] as const)
  );
}

type MemoryRecord = Pick<
  MemoryEntry,
  "object_id" | "object_kind" | "storage_tier" | "updated_at" | "last_hit_at"
>;

async function promoteSingleRecallHit(
  params: Readonly<{
    readonly deps: RecallUsageHandlerDependencies;
    readonly warn: WarnPort;
  }>,
  current: Readonly<MemoryRecord>,
  objectId: string,
  workspaceId: string,
  runId: string | null,
  agentTarget: string,
  reportedAt: string
): Promise<void> {
  const isReuseHit = current.last_hit_at !== null && current.last_hit_at !== undefined;
  if (current.storage_tier === StorageTier.HOT) {
    await refreshScopedRecallUsage(params.deps, objectId, workspaceId, reportedAt);
    await maybeEmitReuseGainKarma(params, isReuseHit, objectId, workspaceId, runId);
    return;
  }

  const event = {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
    entity_type: "memory_entry",
    entity_id: current.object_id,
    workspace_id: workspaceId,
    run_id: runId,
    caused_by: agentTarget,
    payload_json: SoulMemoryTierPromotedPayloadSchema.parse({
      object_id: current.object_id,
      object_kind: current.object_kind,
      workspace_id: workspaceId,
      run_id: runId,
      from_tier: current.storage_tier,
      to_tier: StorageTier.HOT,
      reason: "recall_hit",
      occurred_at: reportedAt
    })
  } as const;

  try {
    await params.deps.eventPublisher?.appendManyWithMutation([event], () => {
      const updated = params.deps.memoryEntryRepo?.updateTier({
        objectId: current.object_id,
        workspaceId,
        fromTier: current.storage_tier,
        toTier: StorageTier.HOT,
        updatedAt: reportedAt,
        expectedUpdatedAt: current.updated_at,
        activationBump: RECALL_HIT_ACTIVATION_BUMP,
        lastUsedAt: reportedAt,
        lastHitAt: reportedAt
      });
      if (updated === null || updated === undefined) {
        throw new RecallHitTierPromotionCasMiss();
      }
      return updated;
    });
  } catch (error) {
    if (!(error instanceof RecallHitTierPromotionCasMiss)) {
      throw error;
    }
    return;
  }
  await maybeEmitReuseGainKarma(params, isReuseHit, objectId, workspaceId, runId);
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

function validateUsedObjectsBelongToDelivery(
  request: SoulReportContextUsageRequest,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null,
  usedObjectIds: readonly string[]
): void {
  if (linkedDelivery === null) {
    return;
  }
  const deliveredIds = new Set(linkedDelivery.delivered_object_ids);
  for (const objectId of usedObjectIds) {
    if (!deliveredIds.has(objectId)) {
      throw new ContextUsageValidationError(
        `used_object_ids include ${objectId}, which was not part of delivery ${request.delivery_id}.`
      );
    }
  }
}

function validateUsedIdsMatchDeliveredObjects(
  request: SoulReportContextUsageRequest,
  deliveredObjects: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>
): void {
  if (request.used_object_ids === undefined) {
    return;
  }
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
