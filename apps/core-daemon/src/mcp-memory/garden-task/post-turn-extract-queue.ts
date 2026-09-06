import { createHash } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  POST_TURN_EXTRACT_EXCERPT_MAX_CHARS,
  type ContextDeliveryRecord,
  type SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import { isDuplicateKeyError } from "@do-soul/alaya-storage";
import {
  createVerifiedDeliverySourceObservation,
  type VerifiedDeliverySourceObservation
} from "../../runtime/recall-materialization/recall-materialization-source-receipt.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "../recall/recall-usage-handlers.js";

export function enqueuePostTurnExtractTask(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly now: () => string }>,
  request: SoulReportContextUsageRequest,
  context: RecallUsageToolCallContext,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null
): void {
  const attribution = resolveReportSideEffectAttribution(linkedDelivery, context);
  if (
    params.deps.gardenTaskRepo === undefined ||
    attribution === null ||
    attribution.runId === null ||
    request.turn_index === undefined ||
    (request.turn_digest?.last_messages?.length ?? 0) === 0
  ) {
    return;
  }

  const workspaceId = attribution.workspaceId;
  const runId = attribution.runId;
  const turnIndex = request.turn_index;
  const deliveredObjectIds = resolveDeliveredObjectIds(request);
  const lastMessages = normalizeTurnDigestMessages(request.turn_digest?.last_messages ?? []);
  const taskId = buildPostTurnExtractTaskId(workspaceId, runId, turnIndex);
  const createdAt = params.now();

  try {
    params.deps.gardenTaskRepo.enqueue({
      id: taskId,
      workspace_id: workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: buildPostTurnExtractPayload({
        taskId,
        workspaceId,
        runId,
        deliveredObjectIds,
        createdAt,
        sourceObservation: linkedDelivery === null
          ? null
          : createVerifiedDeliverySourceObservation([linkedDelivery]),
        turnIndex,
        lastMessages
      }),
      created_at: createdAt
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return;
    }
    // report_context_usage is caller-driven; enqueue failure must surface
    // rather than drop an explicit post-turn signal.
    throw error;
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

function resolveDeliveredObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
  const ids =
    request.delivered_objects === undefined
      ? request.used_object_ids ?? []
      : request.delivered_objects
        .filter((object) => (object.object_kind ?? "memory_entry") === "memory_entry")
        .map((object) => object.object_id);
  return Object.freeze([...new Set(ids)]);
}

function normalizeTurnDigestMessages(
  messages: NonNullable<SoulReportContextUsageRequest["turn_digest"]>["last_messages"]
): readonly { readonly role: string; readonly content_excerpt: string }[] {
  return Object.freeze(
    messages.map((message) =>
      Object.freeze({
        role: message.role,
        content_excerpt: message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
      })
    )
  );
}

function buildPostTurnExtractPayload(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly deliveredObjectIds: readonly string[];
  readonly createdAt: string;
  readonly sourceObservation: VerifiedDeliverySourceObservation | null;
  readonly turnIndex: number;
  readonly lastMessages: readonly { readonly role: string; readonly content_excerpt: string }[];
}) {
  return Object.freeze({
    task_id: input.taskId,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: GardenTier.TIER_2,
    run_id: input.runId,
    target_object_refs: input.deliveredObjectIds,
    priority: 20 as const,
    created_at: input.createdAt,
    ...(input.sourceObservation === null ? {} : { source_observation: input.sourceObservation }),
    turn_index: input.turnIndex,
    workspace_id: input.workspaceId,
    turn_digest: Object.freeze({
      last_messages: input.lastMessages,
      context_manifest: Object.freeze({
        delivered_object_ids: input.deliveredObjectIds
      })
    })
  });
}

function buildPostTurnExtractTaskId(
  workspaceId: string,
  runId: string,
  turnIndex: number
): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(String(turnIndex))
    .digest("hex")
    .slice(0, 32);
  return `post_turn_extract_${digest}`;
}
