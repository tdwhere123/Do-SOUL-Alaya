import { createHash } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type ContextDeliveryRecord,
  type SoulReportContextUsageRequest,
  type HostOccurrence,
  type SourceAdmissionPort
} from "@do-soul/alaya-protocol";
import {
  retainedSourceSpeaker,
  type ConversationGardenCompileEnqueueInput,
  type ConversationGardenCompileEnqueueResult
} from "@do-soul/alaya-core";
import { isDuplicateKeyError } from "@do-soul/alaya-storage";
import { renderOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import {
  admitPostTurnSourceRoot
} from "../../garden/post-turn-extract/admitted-source-root.js";
import {
  createVerifiedDeliverySourceObservation,
  type VerifiedDeliverySourceObservation
} from "../../runtime/recall-materialization/recall-materialization-source-receipt.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "../recall/recall-usage-handlers.js";

export async function enqueuePostTurnExtractTask(
  params: Readonly<{ readonly deps: Pick<RecallUsageHandlerDependencies, "gardenTaskRepo" | "sourceAdmission">; readonly now: () => string }>,
  request: SoulReportContextUsageRequest,
  context: RecallUsageToolCallContext,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null
): Promise<void> {
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
  if (params.deps.gardenTaskRepo.findByIdInWorkspace(taskId, workspaceId) !== null) return;
  const createdAt = params.now();
  const sourceObservation = linkedDelivery === null
    ? null
    : createVerifiedDeliverySourceObservation([linkedDelivery]);
  const sourceCapture = await persistAdmittedTurnRoot(params.deps.sourceAdmission, {
    taskId,
    workspaceId,
    createdAt,
    lastMessages,
    // Delivery time dates the context exposure, not the returned messages.
    eventTime: null
  });

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
        sourceObservation,
        turnIndex,
        lastMessages,
        sourceCapture
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

export async function enqueueConversationGardenCompileTask(
  params: Readonly<{
    readonly gardenTaskRepo: {
      enqueue(input: Parameters<NonNullable<RecallUsageHandlerDependencies["gardenTaskRepo"]>["enqueue"]>[0]): {
        readonly task_id: string;
      };
      findById(taskId: string): { readonly id: string } | null;
    };
    readonly now: () => string;
    readonly sourceAdmission?: SourceAdmissionPort;
  }>,
  input: ConversationGardenCompileEnqueueInput
): Promise<ConversationGardenCompileEnqueueResult> {
  const taskId = buildConversationCompileTaskId(
    input.workspaceId,
    input.runId,
    input.userMessage.message_id,
    input.assistantMessage.message_id
  );
  if (params.gardenTaskRepo.findById(taskId) !== null) {
    return { status: "duplicate" };
  }

  const createdAt = params.now();
  const lastMessages = Object.freeze([
    Object.freeze({
      role: input.userMessage.role,
      content_excerpt: input.userMessage.content,
      message_id: input.userMessage.message_id
    }),
    Object.freeze({
      role: input.assistantMessage.role,
      content_excerpt: input.assistantMessage.content,
      message_id: input.assistantMessage.message_id
    })
  ]);
  const sourceCapture = await persistAdmittedTurnRoot(params.sourceAdmission, {
    taskId,
    workspaceId: input.workspaceId,
    createdAt,
    lastMessages: lastMessages.map((message, index) => ({ ...message,
      event_time: index === 0 ? input.userMessage.created_at : input.assistantMessage.created_at })),
    eventTime: input.userMessage.created_at ?? null
  });

  try {
    params.gardenTaskRepo.enqueue({
      id: taskId,
      workspace_id: input.workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      payload: buildPostTurnExtractPayload({
        taskId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        deliveredObjectIds: [],
        createdAt,
        sourceObservation: null,
        sourceObservedAt: input.userMessage.created_at,
        turnIndex: buildConversationCompileTurnIndex(
          input.userMessage.message_id,
          input.assistantMessage.message_id
        ),
        lastMessages,
        sourceCapture
      }),
      created_at: createdAt
    });
    return { status: "enqueued" };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { status: "duplicate" };
    }
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
        .flatMap((object) => object.object_id === undefined ? [] : [object.object_id]);
  return Object.freeze([...new Set(ids)]);
}

async function persistAdmittedTurnRoot(
  admission: SourceAdmissionPort | undefined,
  input: Readonly<{
    readonly taskId: string;
    readonly workspaceId: string;
    readonly createdAt: string;
    readonly lastMessages: readonly { readonly role: string; readonly content_excerpt: string; readonly event_time?: string }[];
    readonly eventTime: string | null;
  }>
): Promise<{ rootId: string | undefined; resourceLimitedRecordIds: readonly string[] }> {
  if (admission === undefined) return { rootId: undefined, resourceLimitedRecordIds: [] };
  if (admission.audit === undefined) throw new Error("post-turn capture requires receipt-first source audit");
  const speaker = retainedSourceSpeaker(input.lastMessages.map((message) => message.role));
  const sourceRecordIds: string[] = [];
  const resourceLimitedRecordIds: string[] = [];
  for (const [index, message] of input.lastMessages.entries()) {
    const role = retainedSourceSpeaker([message.role]);
    const raw = admitPostTurnSourceRoot({
      admission,
      workspaceId: input.workspaceId,
      sourceId: `post-turn:${input.taskId}:message:${index}`,
      content: message.content_excerpt,
      recordedAt: input.createdAt,
      eventTime: message.event_time ?? null,
      ...(role === undefined ? {} : { speaker: role }),
      scope_class: "project",
      source_representation: { kind: "retained_excerpt" },
      host_occurrences: [reportedOccurrence(input.taskId, index, message.role,
        [0, Buffer.byteLength(message.content_excerpt, "utf8")], "original_bytes")]
    });
    if (raw !== null) {
      await admission.audit(raw.record);
      sourceRecordIds.push(raw.record.identity);
      if (raw.hostCapture === "uncaptured_resource_limit") resourceLimitedRecordIds.push(raw.record.identity);
    }
  }
  if (sourceRecordIds.length === 0) return { rootId: undefined, resourceLimitedRecordIds };
  const rendered = renderOfficialApiSourceCorpus("", input.lastMessages.map(message => ({
    role: message.role, content: message.content_excerpt
  })));
  const record = admitPostTurnSourceRoot({
    admission,
    workspaceId: input.workspaceId,
    sourceId: `post-turn:${input.taskId}`,
    content: rendered.content,
    host_occurrences: rendered.occurrences.map(row => reportedOccurrence(input.taskId, row.message_index,
      input.lastMessages[row.message_index]!.role, row.utf8_span, row.fidelity)),
    recordedAt: input.createdAt,
    eventTime: input.eventTime,
    ...(speaker === undefined ? {} : { speaker }),
    scope_class: "project",
    source_representation: { kind: "canonical_projection", source_record_ids: sourceRecordIds }
  });
  if (record !== null) {
    await admission.audit(record.record);
    if (record.hostCapture === "uncaptured_resource_limit") resourceLimitedRecordIds.push(record.record.identity);
  }
  return { rootId: record?.record.identity, resourceLimitedRecordIds };
}

function reportedOccurrence(taskId: string, index: number, role: string, utf8_span: readonly [number, number],
  fidelity: HostOccurrence["fidelity"]): HostOccurrence {
  return { occurrence_id: `post-turn:${taskId}:message:${index}`, utf8_span, role, channel: null,
    author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
    completeness: "excerpt", fidelity };
}

function normalizeTurnDigestMessages(
  messages: NonNullable<SoulReportContextUsageRequest["turn_digest"]>["last_messages"]
): readonly { readonly role: string; readonly content_excerpt: string }[] {
  return Object.freeze(
    messages.map((message) =>
      Object.freeze({
        role: message.role,
        content_excerpt: message.content_excerpt
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
  readonly sourceObservedAt?: string;
  readonly turnIndex: number;
  readonly lastMessages: readonly {
    readonly role: string;
    readonly content_excerpt: string;
    readonly message_id?: string;
  }[];
  readonly sourceCapture: Awaited<ReturnType<typeof persistAdmittedTurnRoot>>;
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
    ...(input.sourceObservedAt === undefined ? {} : { source_observed_at: input.sourceObservedAt }),
    ...(input.sourceCapture.rootId === undefined
      ? {}
      : { admitted_source_root_id: input.sourceCapture.rootId }),
    // Operational capture outcome only; absent inventories remain unknown, never known-empty.
    ...(input.sourceCapture.resourceLimitedRecordIds.length === 0 ? {} : {
      host_capture_limitations: input.sourceCapture.resourceLimitedRecordIds.map(record_id => ({
        record_id, status: "uncaptured", reason: "resource_limit"
      }))
    }),
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

function buildConversationCompileTaskId(
  workspaceId: string,
  runId: string,
  userMessageId: string,
  assistantMessageId: string
): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update("conversation_compile")
    .update("\0")
    .update(userMessageId)
    .update("\0")
    .update(assistantMessageId)
    .digest("hex")
    .slice(0, 32);
  return `post_turn_extract_${digest}`;
}

function buildConversationCompileTurnIndex(
  userMessageId: string,
  assistantMessageId: string
): number {
  const digest = createHash("sha256")
    .update(userMessageId)
    .update("\0")
    .update(assistantMessageId)
    .digest("hex");
  return Number.parseInt(digest.slice(0, 7), 16);
}
