import {
  GardenTaskKind,
  type CandidateMemorySignal,
  type EdgeClassifyVerdict,
  type GardenClaimTaskRequest,
  type GardenListPendingTasksRequest,
  type GardenRoleValue
} from "@do-soul/alaya-protocol";
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

export function createGardenTaskHandlers(params: Readonly<{
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
  readonly warn: WarnPort;
  readonly generateId: () => string;
}>) {
  const completion = createGardenTaskCompletionHandler(params);
    return {
      listPendingGardenTasks: createListPendingGardenTasks(params.deps),
      claimGardenTask: createClaimGardenTaskHandler(params),
      completeGardenTask: completion.completeGardenTask
    };
  }

function createListPendingGardenTasks(deps: GardenTaskHandlerDependencies) {
  return async function listPendingGardenTasks(
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
    return { tasks: rows.map(toGardenTaskSnapshot) };
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
    const claimResult = repo.claimAtomic(
      request.task_id,
      context.agentTarget,
      params.now(),
      context.workspaceId
    );
    const row = repo.findById(request.task_id);
    if (row === null || row.workspace_id !== context.workspaceId) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    if (claimResult !== "claimed" && row.claimed_by !== context.agentTarget) {
      return toSilentAlreadyClaimed(request.task_id);
    }
    return { status: claimResult === "claimed" ? "claimed" : "already_claimed", ...toGardenClaimTaskPayload(row) };
  };
}
