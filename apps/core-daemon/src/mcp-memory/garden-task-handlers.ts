import { createHash } from "node:crypto";
import {
  CandidateMemorySignalMemoryRefKeys,
  CandidateMemorySignalSchema,
  EdgeClassifyTaskPayloadSchema,
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  GardenTaskKind,
  GardenRole,
  parseGardenEventPayload,
  SignalSource,
  type CandidateMemorySignal,
  type EdgeClassifyVerdict,
  type GardenClaimTaskRequest,
  type GardenCompleteTaskRequest,
  type GardenListPendingTasksRequest,
  type GardenMcpWorkerRole,
  type GardenRoleValue
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskCompletionResult,
  GardenTaskEventInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import { stableStringify } from "@do-soul/alaya-core";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import { buildGardenTaskSignalId } from "../garden/index.js";

const EDGE_CLASSIFY_STALE_AFTER_MS = 5 * 60 * 1000;

type WarnPort = (message: string, meta: Record<string, unknown>) => void;
type GardenCompletionCandidateSignal = NonNullable<
  NonNullable<GardenCompleteTaskRequest["result_envelope"]>["candidate_signals"]
>[number];
type CandidateSignalGraphRefKey = (typeof CandidateMemorySignalMemoryRefKeys)[number];
type CandidateSignalGraphRefInput = {
  readonly raw_payload: Readonly<Record<string, unknown>>;
} & Partial<Record<CandidateSignalGraphRefKey, readonly string[]>>;

export interface GardenTaskToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
}

export interface GardenTaskHandlerDependencies {
  readonly gardenTaskRepo?: {
    findById(taskId: string): GardenTaskRow | null;
    peekPending(
      role: GardenRoleValue,
      workspace_id?: string,
      limit?: number
    ): readonly GardenTaskRow[];
    claimAtomic(
      taskId: string,
      claimedBy: string,
      claimedAt: string,
      workspace_id?: string
    ): "claimed" | "already-claimed";
    completeWithEvents(
      taskId: string,
      result: GardenTaskCompletionResult,
      events: readonly GardenTaskEventInput[],
      claimedBy: string
    ): Promise<void>;
    beginCompletionAttempt(
      taskId: string,
      claimedBy: string,
      completionClaimedBy: string,
      claimedAt: string,
      completionEnvelopeJson?: string | null
    ): boolean;
    releaseClaim(taskId: string, claimedBy: string): boolean;
    countByKind?(
      kind: string,
      staleBeforeIso: string,
      workspace_id?: string
    ): { readonly kind: string; readonly pending: number; readonly stale: number };
  };
  readonly signalService: {
    receiveSignal(signal: CandidateMemorySignal): Promise<Readonly<{
      readonly signal: Readonly<CandidateMemorySignal>;
    }>>;
  };
  readonly edgeVerdictApplier?: {
    applyVerdict(input: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly sourceSignalId: string | null;
      readonly verdict: EdgeClassifyVerdict;
    }): Promise<string | null>;
  };
}

class GardenTaskValidationError extends Error {
  public readonly code = "VALIDATION" as const;
}

class GardenTaskUnavailableError extends Error {
  public readonly code = "UNAVAILABLE" as const;
}

class GardenTaskNotFoundError extends Error {
  public readonly code = "NOT_FOUND" as const;
}

export function createGardenTaskHandlers(params: Readonly<{
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
  readonly generateId: () => string;
}>) {
  const { deps } = params;

  async function listPendingGardenTasks(
    request: GardenListPendingTasksRequest,
    context: GardenTaskToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }
    const rows = deps.gardenTaskRepo.peekPending(
      mapGardenMcpWorkerRole(request.role),
      context.workspaceId,
      request.limit
    );
    return {
      tasks: rows.map(toGardenTaskSnapshot)
    };
  }

  async function claimGardenTask(
    request: GardenClaimTaskRequest,
    context: GardenTaskToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }

    const claimedAt = params.now();
    const claimResult = deps.gardenTaskRepo.claimAtomic(
      request.task_id,
      context.agentTarget,
      claimedAt,
      context.workspaceId
    );
    const row = deps.gardenTaskRepo.findById(request.task_id);
    if (row === null || row.workspace_id !== context.workspaceId) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    if (claimResult !== "claimed" && row.claimed_by !== context.agentTarget) {
      return toSilentAlreadyClaimed(request.task_id);
    }

    return {
      status: claimResult === "claimed" ? "claimed" : "already_claimed",
      ...toGardenClaimTaskPayload(row)
    };
  }

  async function completeGardenTask(
    request: GardenCompleteTaskRequest,
    context: GardenTaskToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }

    const row = deps.gardenTaskRepo.findById(request.task_id);
    if (row === null || row.workspace_id !== context.workspaceId) {
      throw new GardenTaskNotFoundError(`Garden task not found: ${request.task_id}`);
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

    const taskPayloadRunId =
      isUnknownRecord(row.payload) && typeof row.payload.run_id === "string" && row.payload.run_id.length > 0
        ? row.payload.run_id
        : null;
    const resolvedRunId = taskPayloadRunId ?? context.runId;

    const edgeVerdict = request.result_envelope?.edge_verdict;
    const candidateSignalsCount = request.result_envelope?.candidate_signals?.length ?? 0;
    if (row.kind === GardenTaskKind.EDGE_CLASSIFY) {
      if (candidateSignalsCount > 0) {
        throw new GardenTaskValidationError(
          `Garden task ${row.id} is an edge_classify task; complete it with result_envelope.edge_verdict, not candidate_signals.`
        );
      }
      return await completeEdgeClassifyTask(
        request,
        context,
        row,
        resolvedRunId,
        edgeVerdict
      );
    }
    if (edgeVerdict !== undefined) {
      throw new GardenTaskValidationError(
        `Garden task ${row.id} (${row.kind}) does not accept an edge_verdict; that result shape is only valid for edge_classify tasks.`
      );
    }

    const contentOnlySignals = request.result_envelope?.candidate_signals ?? [];
    const completionEnvelopeJson =
      contentOnlySignals.length === 0
        ? null
        : buildGardenCompletionEnvelopeJson(row.id, contentOnlySignals);

    if (contentOnlySignals.length > 0 && resolvedRunId === null) {
      throw new GardenTaskValidationError(
        "garden.complete_task cannot emit candidate_signals without a run_id in the task payload or MCP call context."
      );
    }
    if (row.completion_envelope_json !== null && row.completion_envelope_json !== completionEnvelopeJson) {
      throw new GardenTaskValidationError(
        `Garden task ${row.id} candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope.`
      );
    }

    const completionClaimedBy =
      contentOnlySignals.length === 0
        ? context.agentTarget
        : `${context.agentTarget}:complete:${params.generateId()}`;
    if (contentOnlySignals.length > 0) {
      const completionClaimStarted = deps.gardenTaskRepo.beginCompletionAttempt(
        row.id,
        context.agentTarget,
        completionClaimedBy,
        params.now(),
        completionEnvelopeJson
      );
      if (!completionClaimStarted) {
        throw new GardenTaskValidationError(
          `Garden task ${row.id} claim changed before candidate signal emission; retry after claiming the task again.`
        );
      }
    }

    const emittedSignalIds: string[] = [];
    try {
      for (const [index, signalContent] of contentOnlySignals.entries()) {
        const internalSignal = normalizeSchemaGroundedSignal(CandidateMemorySignalSchema.parse({
          signal_id: buildGardenTaskSignalId(row.id, index),
          ...normalizeCandidateSignalGraphRefs(signalContent, params.warn),
          workspace_id: context.workspaceId,
          run_id: resolvedRunId,
          surface_id: null,
          source: SignalSource.GARDEN_COMPILE,
          created_at: params.now()
        }));
        const received = await deps.signalService.receiveSignal(internalSignal);
        emittedSignalIds.push(received.signal.signal_id);
      }

      const completedAt = params.now();
      const event: GardenTaskEventInput = {
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
          success: request.status === "completed",
          objects_affected: emittedSignalIds,
          candidate_signals_count: emittedSignalIds.length,
          workspace_id: context.workspaceId,
          occurred_at: completedAt
        })
      };

      await deps.gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: request.status,
          completed_at: completedAt,
          ...(request.last_error_text === undefined ? {} : { last_error_text: request.last_error_text })
        },
        [event],
        completionClaimedBy
      );
    } catch (error) {
      if (contentOnlySignals.length > 0) {
        const released = deps.gardenTaskRepo.releaseClaim(row.id, completionClaimedBy);
        if (!released) {
          params.warn("Garden task completion claim could not be released after partial failure.", {
            task_id: row.id,
            claimed_by: completionClaimedBy,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      throw error;
    }

    return {
      task_id: row.id,
      status: request.status,
      events_appended: 1
    };
  }

  async function completeEdgeClassifyTask(
    request: GardenCompleteTaskRequest,
    context: GardenTaskToolCallContext,
    row: GardenTaskRow,
    resolvedRunId: string | null,
    verdict: EdgeClassifyVerdict | undefined
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }

    let objectsAffected: readonly string[] = [];
    if (request.status === "completed") {
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
      if (outcome === "applied") {
        objectsAffected = [payloadPair.sourceObjectId, payloadPair.neighborObjectId];
      }
    }

    const completedAt = params.now();
    const event: GardenTaskEventInput = {
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
        success: request.status === "completed",
        objects_affected: [...objectsAffected],
        candidate_signals_count: 0,
        workspace_id: context.workspaceId,
        occurred_at: completedAt
      })
    };

    await deps.gardenTaskRepo.completeWithEvents(
      row.id,
      {
        status: request.status,
        completed_at: completedAt,
        ...(request.last_error_text === undefined ? {} : { last_error_text: request.last_error_text })
      },
      [event],
      context.agentTarget
    );

    emitEdgeClassifyBacklogDiagnostic(context.workspaceId);

    return {
      task_id: row.id,
      status: request.status,
      events_appended: 1
    };
  }

  function emitEdgeClassifyBacklogDiagnostic(workspaceId: string): void {
    const repo = deps.gardenTaskRepo;
    if (repo?.countByKind === undefined) {
      return;
    }
    try {
      const staleBeforeIso = new Date(Date.now() - EDGE_CLASSIFY_STALE_AFTER_MS).toISOString();
      const backlog = repo.countByKind(GardenTaskKind.EDGE_CLASSIFY, staleBeforeIso, workspaceId);
      params.warn("edge_classify backlog (heuristic edges awaiting host-worker LLM verdict)", {
        workspace_id: workspaceId,
        pending: backlog.pending,
        stale: backlog.stale
      });
    } catch (error) {
      params.warn("edge_classify backlog diagnostic failed", {
        workspace_id: workspaceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    listPendingGardenTasks,
    claimGardenTask,
    completeGardenTask
  };
}

function buildGardenCompletionEnvelopeJson(
  taskId: string,
  signals: readonly GardenCompletionCandidateSignal[]
): string {
  const signalIds = signals.map((_, index) => buildGardenTaskSignalId(taskId, index));
  const fingerprint = createHash("sha256")
    .update(stableStringify({
      task_id: taskId,
      candidate_signal_ids: signalIds,
      candidate_signals: signals
    }))
    .digest("hex");

  return JSON.stringify({
    version: 1,
    task_id: taskId,
    candidate_signal_count: signals.length,
    candidate_signal_ids: signalIds,
    fingerprint
  });
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapGardenMcpWorkerRole(role: GardenMcpWorkerRole | undefined): GardenRoleValue {
  switch (role) {
    case "janitor":
      return GardenRole.JANITOR;
    case "auditor":
      return GardenRole.AUDITOR;
    case "librarian":
    case "host_worker":
    case undefined:
      return GardenRole.LIBRARIAN;
  }
}

function toGardenTaskSnapshot(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    created_at: row.created_at,
    payload: publicGardenTaskPayload(row)
  };
}

function toGardenClaimTaskPayload(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    payload: publicGardenTaskPayload(row)
  };
}

const HOST_WORKER_TASK_KINDS: ReadonlySet<string> = new Set([
  GardenTaskKind.POST_TURN_EXTRACT,
  GardenTaskKind.EDGE_CLASSIFY
]);

function gardenWorkerRoleForRow(row: GardenTaskRow): string {
  return HOST_WORKER_TASK_KINDS.has(row.kind) ? "host_worker" : row.role;
}

function publicGardenTaskPayload(row: GardenTaskRow): unknown {
  if (!isUnknownRecord(row.payload)) {
    return row.payload;
  }
  if (row.kind === GardenTaskKind.POST_TURN_EXTRACT) {
    return {
      run_id: row.payload.run_id,
      turn_index: row.payload.turn_index,
      workspace_id: row.payload.workspace_id,
      turn_digest: row.payload.turn_digest
    };
  }
  if (row.kind === GardenTaskKind.EDGE_CLASSIFY) {
    return {
      run_id: row.payload.run_id,
      workspace_id: row.payload.workspace_id,
      dimension: row.payload.dimension,
      scope_class: row.payload.scope_class,
      source_memory: row.payload.source_memory,
      neighbor_memory: row.payload.neighbor_memory
    };
  }
  return row.payload;
}

function readEdgeClassifyPayloadPair(taskId: string, payload: unknown): {
  readonly sourceObjectId: string;
  readonly neighborObjectId: string;
  readonly sourceSignalId: string | null;
} {
  const parsed = EdgeClassifyTaskPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GardenTaskValidationError(
      `Garden task ${taskId} has malformed EDGE_CLASSIFY payload; cannot validate edge_verdict pair.`
    );
  }
  return {
    sourceObjectId: parsed.data.source_memory.object_id,
    neighborObjectId: parsed.data.neighbor_memory.object_id,
    sourceSignalId: parsed.data.source_signal_id ?? null
  };
}

function toSilentAlreadyClaimed(taskId: string) {
  return {
    status: "already_claimed",
    task_id: taskId,
    role: "unknown",
    kind: "unknown",
    payload: null
  };
}

function normalizeCandidateSignalGraphRefs<T extends CandidateSignalGraphRefInput>(
  input: T,
  warn: WarnPort
): T {
  const offendingKeys: CandidateSignalGraphRefKey[] = [];
  for (const key of CandidateMemorySignalMemoryRefKeys) {
    if (hasOwnProperty(input.raw_payload, key)) {
      offendingKeys.push(key);
    }
  }
  if (offendingKeys.length > 0) {
    warn(
      "candidate signal raw_payload contains graph-edge ref keys; use first-class fields instead. Ignoring raw_payload entries.",
      {
        offending_keys: offendingKeys
      }
    );
  }
  return input;
}

function hasOwnProperty(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
