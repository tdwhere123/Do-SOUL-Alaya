import type { CandidateMemorySignal, GardenCompleteTaskRequest } from "@do-soul/alaya-protocol";
import type { GardenTaskRow } from "@do-soul/alaya-storage";
import { finalizePostTurnEvidence } from "../../garden/post-turn-extract/evidence-finalizer.js";
import {
  buildPostTurnContent,
  parsePostTurnExtractTaskPayload,
  type PostTurnExtractTaskPayload
} from "../../garden/post-turn-extract/task-payload.js";
import {
  GardenTaskUnavailableError,
  GardenTaskValidationError
} from "../garden-task-handler-support.js";
import type {
  GardenTaskHandlerDependencies,
  GardenTaskToolCallContext
} from "../garden-task-handlers.js";

interface CandidateSignalEmissionParams {
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
}

export async function emitTaskCandidateSignals(
  params: CandidateSignalEmissionParams,
  request: GardenCompleteTaskRequest,
  row: GardenTaskRow,
  postTurnPayload: PostTurnExtractTaskPayload | null,
  candidateSignals: readonly CandidateMemorySignal[],
  completionClaimedBy: string
): Promise<readonly string[]> {
  if (postTurnPayload !== null && request.status === "completed") {
    return await finalizeExternalPostTurnEvidence(
      params, row, postTurnPayload, candidateSignals, completionClaimedBy
    );
  }
  const emittedSignalIds: string[] = [];
  for (const signal of candidateSignals) {
    const received = await params.deps.signalService.receiveSignal(signal);
    emittedSignalIds.push(received.signal.signal_id);
  }
  return emittedSignalIds;
}

export function readExternalPostTurnPayload(
  row: GardenTaskRow,
  context: GardenTaskToolCallContext,
  resolvedRunId: string | null
): PostTurnExtractTaskPayload {
  const payload = parsePostTurnExtractTaskPayload(row.payload);
  if (payload.workspace_id !== context.workspaceId || payload.run_id !== resolvedRunId) {
    throw new GardenTaskValidationError(
      `Garden task ${row.id} post-turn payload escaped the claimed workspace or run.`
    );
  }
  return payload;
}

async function finalizeExternalPostTurnEvidence(
  params: CandidateSignalEmissionParams,
  row: GardenTaskRow,
  payload: PostTurnExtractTaskPayload,
  candidates: readonly CandidateMemorySignal[],
  completionClaimedBy: string
): Promise<readonly string[]> {
  const receiver = params.deps.postTurnSignalReceiver;
  if (receiver === undefined) {
    throw new GardenTaskUnavailableError(
      "garden.complete_task cannot finalize post-turn evidence without a durable signal receiver."
    );
  }
  return await finalizePostTurnEvidence({
    taskId: row.id,
    workspaceId: payload.workspace_id,
    runId: payload.run_id,
    createdAt: payload.created_at ?? row.created_at,
    turnContent: buildPostTurnContent(payload),
    sourceObservation: payload.source_observation,
    candidates,
    signalReceiver: receiver,
    beforeReceive: async () => {
      if (params.deps.gardenTaskRepo!.refreshClaim(row.id, completionClaimedBy, params.now())) return;
      throw new GardenTaskValidationError(
        `Garden task ${row.id} completion claim changed before candidate signal emission.`
      );
    }
  });
}
