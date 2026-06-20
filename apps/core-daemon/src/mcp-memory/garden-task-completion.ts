import {
  CandidateMemorySignalSchema,
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  GardenTaskKind,
  parseGardenEventPayload,
  SignalSource,
  type EdgeClassifyVerdict,
  type GardenCompleteTaskRequest
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskEventInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import { buildGardenTaskSignalId } from "../garden/index.js";
import {
  buildGardenCompletionEnvelopeJson,
  GardenTaskNotFoundError,
  GardenTaskUnavailableError,
  GardenTaskValidationError,
  isUnknownRecord,
  normalizeCandidateSignalGraphRefs,
  readEdgeClassifyPayloadPair
} from "./garden-task-handler-support.js";
import type { GardenTaskHandlerDependencies, GardenTaskToolCallContext } from "./garden-task-handlers.js";

const EDGE_CLASSIFY_STALE_AFTER_MS = 5 * 60 * 1000;

export function createGardenTaskCompletionHandler(params: Readonly<{
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly generateId: () => string;
}>): Readonly<{
  completeGardenTask(
    request: GardenCompleteTaskRequest,
    context: GardenTaskToolCallContext
  ): Promise<{ readonly task_id: string; readonly status: string; readonly events_appended: 1 }>;
}> {
  return {
    completeGardenTask: async (request, context) => {
      const row = requireClaimedGardenTask(params.deps, request.task_id, context);
      const resolvedRunId = resolveTaskRunId(row, context);
      validateTaskResultEnvelope(request, row, resolvedRunId);

      if (row.kind === GardenTaskKind.EDGE_CLASSIFY) {
        return await completeEdgeClassifyTask(
          params,
          request,
          context,
          row,
          resolvedRunId,
          request.result_envelope?.edge_verdict
        );
      }

      return await completeCandidateSignalTask(
        params,
        request,
        context,
        row,
        resolvedRunId
      );
    }
  };
}

function requireClaimedGardenTask(
  deps: GardenTaskHandlerDependencies,
  taskId: string,
  context: GardenTaskToolCallContext
): GardenTaskRow {
  const repo = deps.gardenTaskRepo;
  if (repo === undefined) {
    throw new GardenTaskUnavailableError("Garden task queue is not available.");
  }
  const row = repo.findById(taskId);
  if (row === null || row.workspace_id !== context.workspaceId) {
    throw new GardenTaskNotFoundError(`Garden task not found: ${taskId}`);
  }
  if (row.status !== "claimed") {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} is not in claimed state (current: ${row.status}); claim it via garden.claim_task before completing.`
    );
  }
  if (row.claimed_by !== context.agentTarget) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} is claimed by a different agent target; only the claimant may complete it.`
    );
  }
  return row;
}

function resolveTaskRunId(
  row: GardenTaskRow,
  context: GardenTaskToolCallContext
): string | null {
  const taskPayloadRunId =
    isUnknownRecord(row.payload) &&
    typeof row.payload.run_id === "string" &&
    row.payload.run_id.length > 0
      ? row.payload.run_id
      : null;
  return taskPayloadRunId ?? context.runId;
}

function validateTaskResultEnvelope(
  request: GardenCompleteTaskRequest,
  row: GardenTaskRow,
  resolvedRunId: string | null
): void {
  const extractedProposalCount = request.result_envelope?.extracted_proposals?.length ?? 0;
  if (extractedProposalCount > 0) {
    throw new GardenTaskValidationError(
      `garden.complete_task does not support result_envelope.extracted_proposals yet; received ${extractedProposalCount} unsupported proposal(s).`
    );
  }

  const edgeVerdict = request.result_envelope?.edge_verdict;
  const candidateSignalsCount = request.result_envelope?.candidate_signals?.length ?? 0;
  if (row.kind === GardenTaskKind.EDGE_CLASSIFY) {
    if (candidateSignalsCount > 0) {
      throw new GardenTaskValidationError(
        `Garden task ${row.id} is an edge_classify task; complete it with result_envelope.edge_verdict, not candidate_signals.`
      );
    }
    return;
  }
  if (edgeVerdict !== undefined) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} (${row.kind}) does not accept an edge_verdict; that result shape is only valid for edge_classify tasks.`
    );
  }
  if (candidateSignalsCount > 0 && resolvedRunId === null) {
    throw new GardenTaskValidationError(
      "garden.complete_task cannot emit candidate_signals without a run_id in the task payload or MCP call context."
    );
  }
}

async function completeCandidateSignalTask(
  params: Readonly<{
    readonly deps: GardenTaskHandlerDependencies;
    readonly now: () => string;
    readonly warn: (message: string, meta: Record<string, unknown>) => void;
    readonly generateId: () => string;
  }>,
  request: GardenCompleteTaskRequest,
  context: GardenTaskToolCallContext,
  row: GardenTaskRow,
  resolvedRunId: string | null
): Promise<{ readonly task_id: string; readonly status: string; readonly events_appended: 1 }> {
  const repo = params.deps.gardenTaskRepo!;
  const contentOnlySignals = request.result_envelope?.candidate_signals ?? [];
  const completionEnvelopeJson =
    contentOnlySignals.length === 0
      ? null
      : buildGardenCompletionEnvelopeJson(row.id, contentOnlySignals);
  if (
    row.completion_envelope_json !== null &&
    row.completion_envelope_json !== completionEnvelopeJson
  ) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope.`
    );
  }

  const completionClaimedBy =
    contentOnlySignals.length === 0
      ? context.agentTarget
      : `${context.agentTarget}:complete:${params.generateId()}`;
  beginCompletionAttemptIfNeeded(repo, row, completionClaimedBy, completionEnvelopeJson, params.now);

  try {
    const emittedSignalIds = await emitCandidateSignals(
      params,
      contentOnlySignals,
      row.id,
      context.workspaceId,
      resolvedRunId
    );
    await repo.completeWithEvents(
      row.id,
      {
        status: request.status,
        completed_at: params.now(),
        ...(request.last_error_text === undefined
          ? {}
          : { last_error_text: request.last_error_text })
      },
      [buildCompletedTaskEvent(row, context, resolvedRunId, request.status, emittedSignalIds, params.now())],
      completionClaimedBy
    );
  } catch (error) {
    releaseCompletionClaim(repo, row.id, completionClaimedBy, error, params.warn);
    throw error;
  }

  return { task_id: row.id, status: request.status, events_appended: 1 };
}

function beginCompletionAttemptIfNeeded(
  repo: NonNullable<GardenTaskHandlerDependencies["gardenTaskRepo"]>,
  row: GardenTaskRow,
  completionClaimedBy: string,
  completionEnvelopeJson: string | null,
  now: () => string
): void {
  if (completionEnvelopeJson === null) {
    return;
  }
  const completionClaimStarted = repo.beginCompletionAttempt(
    row.id,
    row.claimed_by!,
    completionClaimedBy,
    now(),
    completionEnvelopeJson
  );
  if (!completionClaimStarted) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} claim changed before candidate signal emission; retry after claiming the task again.`
    );
  }
}

async function emitCandidateSignals(
  params: Readonly<{
    readonly deps: GardenTaskHandlerDependencies;
    readonly now: () => string;
    readonly warn: (message: string, meta: Record<string, unknown>) => void;
  }>,
  contentOnlySignals: NonNullable<GardenCompleteTaskRequest["result_envelope"]>["candidate_signals"],
  taskId: string,
  workspaceId: string,
  resolvedRunId: string | null
): Promise<string[]> {
  const emittedSignalIds: string[] = [];
  for (const [index, signalContent] of (contentOnlySignals ?? []).entries()) {
    const internalSignal = normalizeSchemaGroundedSignal(CandidateMemorySignalSchema.parse({
      signal_id: buildGardenTaskSignalId(taskId, index),
      ...normalizeCandidateSignalGraphRefs(signalContent!, params.warn),
      workspace_id: workspaceId,
      run_id: resolvedRunId,
      surface_id: null,
      source: SignalSource.GARDEN_COMPILE,
      created_at: params.now()
    }));
    const received = await params.deps.signalService.receiveSignal(internalSignal);
    emittedSignalIds.push(received.signal.signal_id);
  }
  return emittedSignalIds;
}

function releaseCompletionClaim(
  repo: NonNullable<GardenTaskHandlerDependencies["gardenTaskRepo"]>,
  taskId: string,
  completionClaimedBy: string,
  error: unknown,
  warn: (message: string, meta: Record<string, unknown>) => void
): void {
  const released = repo.releaseClaim(taskId, completionClaimedBy);
  if (!released) {
    warn("Garden task completion claim could not be released after partial failure.", {
      task_id: taskId,
      claimed_by: completionClaimedBy,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function completeEdgeClassifyTask(
  params: Readonly<{
    readonly deps: GardenTaskHandlerDependencies;
    readonly now: () => string;
    readonly warn: (message: string, meta: Record<string, unknown>) => void;
  }>,
  request: GardenCompleteTaskRequest,
  context: GardenTaskToolCallContext,
  row: GardenTaskRow,
  resolvedRunId: string | null,
  verdict: EdgeClassifyVerdict | undefined
): Promise<{ readonly task_id: string; readonly status: string; readonly events_appended: 1 }> {
  const objectsAffected = await applyEdgeClassifyVerdict(
    params.deps,
    request,
    context,
    row,
    resolvedRunId,
    verdict
  );

  await params.deps.gardenTaskRepo!.completeWithEvents(
    row.id,
    {
      status: request.status,
      completed_at: params.now(),
      ...(request.last_error_text === undefined ? {} : { last_error_text: request.last_error_text })
    },
    [buildCompletedTaskEvent(row, context, resolvedRunId, request.status, [...objectsAffected], params.now())],
    context.agentTarget
  );

  emitEdgeClassifyBacklogDiagnostic(params.deps, context.workspaceId, params.warn);
  return { task_id: row.id, status: request.status, events_appended: 1 };
}

async function applyEdgeClassifyVerdict(
  deps: GardenTaskHandlerDependencies,
  request: GardenCompleteTaskRequest,
  context: GardenTaskToolCallContext,
  row: GardenTaskRow,
  resolvedRunId: string | null,
  verdict: EdgeClassifyVerdict | undefined
): Promise<readonly string[]> {
  if (request.status !== "completed") {
    return [];
  }
  const payloadPair = readEdgeClassifyPayloadPair(row.id, row.payload);
  if (verdict === undefined) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} is an edge_classify task completed without a result_envelope.edge_verdict; report edge_type "none" for an explicit no-edge decision, or complete with status "failed" if no verdict can be produced.`
    );
  }
  if (
    verdict.source_object_id !== payloadPair.sourceObjectId ||
    verdict.neighbor_object_id !== payloadPair.neighborObjectId
  ) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} edge_verdict pair does not match the claimed task's source/neighbor memory pair.`
    );
  }
  if (deps.edgeVerdictApplier === undefined) {
    throw new GardenTaskUnavailableError(
      "garden.complete_task received an edge_verdict but no edge-classification applier is wired."
    );
  }
  const outcome = await deps.edgeVerdictApplier.applyVerdict({
    workspaceId: context.workspaceId,
    runId: resolvedRunId,
    sourceSignalId: payloadPair.sourceSignalId,
    verdict
  });
  return outcome === "applied"
    ? [payloadPair.sourceObjectId, payloadPair.neighborObjectId]
    : [];
}

function buildCompletedTaskEvent(
  row: GardenTaskRow,
  context: GardenTaskToolCallContext,
  resolvedRunId: string | null,
  status: GardenCompleteTaskRequest["status"],
  objectsAffected: readonly string[],
  completedAt: string
): GardenTaskEventInput {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: row.id,
    workspace_id: context.workspaceId,
    run_id: resolvedRunId,
    caused_by: context.agentTarget,
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: row.id,
      task_kind: row.kind,
      role: row.role,
      tier: GARDEN_ROLE_TIER_MAP[row.role],
      success: status === "completed",
      objects_affected: [...objectsAffected],
      candidate_signals_count: row.kind === GardenTaskKind.EDGE_CLASSIFY ? 0 : objectsAffected.length,
      workspace_id: context.workspaceId,
      occurred_at: completedAt
    })
  };
}

function emitEdgeClassifyBacklogDiagnostic(
  deps: GardenTaskHandlerDependencies,
  workspaceId: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): void {
  const repo = deps.gardenTaskRepo;
  if (repo?.countByKind === undefined) {
    return;
  }
  try {
    const staleBeforeIso = new Date(Date.now() - EDGE_CLASSIFY_STALE_AFTER_MS).toISOString();
    const backlog = repo.countByKind(GardenTaskKind.EDGE_CLASSIFY, staleBeforeIso, workspaceId);
    warn("edge_classify backlog (heuristic edges awaiting host-worker LLM verdict)", {
      workspace_id: workspaceId,
      pending: backlog.pending,
      stale: backlog.stale
    });
  } catch (error) {
    warn("edge_classify backlog diagnostic failed", {
      workspace_id: workspaceId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
