import {
  GardenClaimTaskResponseSchema,
  GardenCompleteTaskResponseSchema,
  GardenListPendingTasksResponseSchema,
  GardenTaskKind,
  GARDEN_TASK_PAYLOAD_MAX_CHARS,
  type CandidateMemorySignal,
  type EdgeClassifyVerdict,
  type GardenClaimTaskRequest,
  type GardenListPendingTasksRequest,
  type GardenRoleValue
} from "@do-soul/alaya-protocol";
import { throwIfAborted } from "@do-soul/alaya-engine-gateway";
import type { GardenTaskOperations } from "../tool/tool-handler-operations.js";
import type {
  GardenTaskCompletionResult,
  GardenTaskEventInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import {
  GardenTaskUnavailableError,
  mapGardenMcpWorkerRole,
  toGardenClaimTaskPayload,
  toGardenTaskSnapshot,
  toSilentAlreadyClaimed,
  type WarnPort
} from "./garden-task-handler-support.js";
import { createGardenTaskCompletionHandler } from "./garden-task-completion.js";
import type { PostTurnSignalReceiver } from "../../garden/post-turn-extract/signal-receiver.js";
import { gardenTaskSourceAvailable, quarantineUnavailablePostTurnTasks,
  type GardenTaskSourceGuardPort } from "../../garden/post-turn-extract/source-provenance.js";

export interface GardenTaskToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly abortSignal?: AbortSignal;
}

export interface GardenTaskHandlerDependencies {
  readonly gardenTaskRepo?: GardenTaskSourceGuardPort & {
    findByIdInWorkspace(taskId: string, workspaceId: string): GardenTaskRow | null;
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
    ): Promise<"claimed" | "already-claimed">;
    completeWithEvents(
      taskId: string,
      result: GardenTaskCompletionResult,
      events: readonly GardenTaskEventInput[],
      claimedBy: string,
      workspaceId: string
    ): Promise<void>;
    beginCompletionAttempt(
      taskId: string,
      claimedBy: string,
      completionClaimedBy: string,
      claimedAt: string,
      completionEnvelopeJson?: string | null
    ): boolean;
    refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean;
    releaseClaim(taskId: string, claimedBy: string): Promise<boolean>;
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
  readonly postTurnSignalReceiver?: PostTurnSignalReceiver;
  readonly edgeVerdictApplier?: {
    applyVerdict(input: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly sourceSignalId: string | null;
      readonly verdict: EdgeClassifyVerdict;
    }): Promise<string | null>;
  };
}

export function createGardenTaskHandlers(params: Readonly<{
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
  readonly generateId: () => string;
}>): GardenTaskOperations {
  const completion = createGardenTaskCompletionHandler(params);
  return {
    listPendingGardenTasks: createListPendingGardenTasks(params.deps, params.now),
    claimGardenTask: createClaimGardenTaskHandler(params),
    completeGardenTask: async (request, context) => {
      throwIfAborted(context.abortSignal);
      return GardenCompleteTaskResponseSchema.parse(await completion.completeGardenTask(request, context));
    }
  };
}

function createListPendingGardenTasks(deps: GardenTaskHandlerDependencies, now: () => string) {
  return async function listPendingGardenTasks(
    request: GardenListPendingTasksRequest,
    context: GardenTaskToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }
    throwIfAborted(context.abortSignal);
    await quarantineUnavailablePostTurnTasks(deps.gardenTaskRepo, now, context.workspaceId);
    const rows = deps.gardenTaskRepo.peekPending(
      mapGardenMcpWorkerRole(request.role),
      context.workspaceId,
      request.limit
    );
    const tasks: ReturnType<typeof toGardenTaskSnapshot>[] = [];
    let payloadChars = 0;
    for (const row of rows) {
      if (!gardenTaskSourceAvailable(deps.gardenTaskRepo, row)) continue;
      const snapshot = toGardenTaskSnapshot(row);
      const size = JSON.stringify(snapshot).length;
      if (tasks.length > 0 && payloadChars + size > GARDEN_TASK_PAYLOAD_MAX_CHARS) break;
      tasks.push(snapshot);
      payloadChars += size;
    }
    return GardenListPendingTasksResponseSchema.parse({ tasks });
  };
}

function createClaimGardenTaskHandler(params: Readonly<{
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
}>) {
  return async function claimGardenTask(
    request: GardenClaimTaskRequest,
    context: GardenTaskToolCallContext
  ) {
    const repo = params.deps.gardenTaskRepo;
    if (repo === undefined) {
      throw new GardenTaskUnavailableError("Garden task queue is not available.");
    }
    throwIfAborted(context.abortSignal);
    await quarantineUnavailablePostTurnTasks(repo, params.now, context.workspaceId, request.task_id);
    const beforeClaim = repo.findByIdInWorkspace(request.task_id, context.workspaceId);
    if (beforeClaim !== null && !gardenTaskSourceAvailable(repo, beforeClaim)) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    if (beforeClaim !== null) {
      GardenClaimTaskResponseSchema.parse({ status: "claimed", ...toGardenClaimTaskPayload(beforeClaim) });
    }
    const claimResult = await repo.claimAtomic(
      request.task_id,
      context.agentTarget,
      params.now(),
      context.workspaceId
    );
    const row = repo.findByIdInWorkspace(request.task_id, context.workspaceId);
    if (row === null || row.status !== "claimed" || !gardenTaskSourceAvailable(repo, row)) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    if (claimResult !== "claimed" && row.claimed_by !== context.agentTarget) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    return GardenClaimTaskResponseSchema.parse({
      status: claimResult === "claimed" ? "claimed" : "already_claimed",
      ...toGardenClaimTaskPayload(row)
    });
  };
}
