import { createHash } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type ContextDeliveryRecord,
  type SoulMemorySearchRequest,
  type SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "./recall-usage-handlers.js";

const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;
// Auto-extract from a recall turn only when there is enough text for the
// Garden compute provider to find a durable signal in; a bare keyword query
// is below this floor and not worth a Garden task.
const MIN_AUTO_EXTRACT_TURN_CHARS = 24;
// Stop enqueuing recall-driven extract tasks once the pending Garden queue
// visible to peekPending(LIBRARIAN, ...) — librarian rows plus the
// higher-priority janitor/auditor rows — for a workspace is this deep: Garden
// is not draining (e.g. host_worker mode with no worker, or a stalled
// background pass) and piling on cannot help. Coarse backpressure —
// over-counting only makes Alaya more conservative.
const RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD = 128;

type WarnPort = (message: string, meta: Record<string, unknown>) => void;

export function enqueueRecallExtractTask(
  params: Readonly<{ readonly deps: RecallUsageHandlerDependencies; readonly now: () => string; readonly warn: WarnPort }>,
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext,
  deliveredObjectIds: readonly string[]
): void {
  const gardenTaskRepo = params.deps.gardenTaskRepo;
  if (gardenTaskRepo === undefined || context.runId === null) {
    return;
  }
  const turnText = (request.recent_turn ?? request.query).trim();
  if (turnText.length < MIN_AUTO_EXTRACT_TURN_CHARS) {
    return;
  }
  const workspaceId = context.workspaceId;
  const runId = context.runId;
  const dedupedDeliveredIds = Object.freeze([...new Set(deliveredObjectIds)]);
  const taskId = buildRecallExtractTaskId(workspaceId, runId, turnText);
  const createdAt = params.now();
  try {
    if (
      gardenTaskRepo.peekPending(
        GardenRole.LIBRARIAN,
        workspaceId,
        RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD
      ).length >= RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD
    ) {
      return;
    }
    gardenTaskRepo.enqueue({
      id: taskId,
      workspace_id: workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: buildPostTurnExtractPayload({
        taskId,
        workspaceId,
        runId,
        deliveredObjectIds: dedupedDeliveredIds,
        createdAt,
        sourceObservedAt: request.source_observed_at,
        turnIndex: 0,
        lastMessages: [
          {
            role: "user",
            content_excerpt: turnText.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
          }
        ]
      }),
      created_at: createdAt
    });
  } catch (error) {
    if (isDuplicatePostTurnExtractTask(error)) {
      return;
    }
    // recall enqueue is best-effort passive ingestion (§17): warn, never throw —
    // throwing would regress the recall MCP response. (Contrast the report path
    // below, which is caller-driven and rethrows.)
    params.warn("recall-driven extract task enqueue failed; skipping.", {
      workspace_id: workspaceId,
      run_id: runId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

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
  if (hasRecallExtractTaskForTurnDigest(params.deps.gardenTaskRepo, workspaceId, runId, lastMessages)) {
    return;
  }
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
        sourceObservedAt: request.source_observed_at,
        turnIndex,
        lastMessages
      }),
      created_at: createdAt
    });
  } catch (error) {
    if (isDuplicatePostTurnExtractTask(error)) {
      return;
    }
    // report path is caller-driven (report_context_usage), so a real enqueue
    // failure rethrows to the caller — deliberately asymmetric with the
    // best-effort recall path above.
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
      : request.delivered_objects.map((object) => object.object_id);
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

function hasRecallExtractTaskForTurnDigest(
  gardenTaskRepo: NonNullable<RecallUsageHandlerDependencies["gardenTaskRepo"]>,
  workspaceId: string,
  runId: string,
  messages: readonly { readonly role: string; readonly content_excerpt: string }[]
): boolean {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const turnText = message.content_excerpt.trim();
    if (turnText.length < MIN_AUTO_EXTRACT_TURN_CHARS) {
      continue;
    }
    if (gardenTaskRepo.findById(buildRecallExtractTaskId(workspaceId, runId, turnText)) !== null) {
      return true;
    }
  }
  return false;
}

function buildPostTurnExtractPayload(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly deliveredObjectIds: readonly string[];
  readonly createdAt: string;
  readonly sourceObservedAt?: string;
  readonly turnIndex: number;
  readonly lastMessages: readonly { readonly role: string; readonly content_excerpt: string }[];
}) {
  const hostObservedAt = input.sourceObservedAt?.trim();
  return Object.freeze({
    task_id: input.taskId,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: GardenTier.TIER_2,
    run_id: input.runId,
    target_object_refs: input.deliveredObjectIds,
    priority: 20 as const,
    created_at: input.createdAt,
    ...(hostObservedAt === undefined || hostObservedAt.length === 0
      ? {}
      : { source_observed_at: hostObservedAt }),
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

function buildRecallExtractTaskId(workspaceId: string, runId: string, turnText: string): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(turnText)
    .digest("hex")
    .slice(0, 32);
  return `recall_extract_${digest}`;
}

function isDuplicatePostTurnExtractTask(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (code === "DUPLICATE_KEY") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
