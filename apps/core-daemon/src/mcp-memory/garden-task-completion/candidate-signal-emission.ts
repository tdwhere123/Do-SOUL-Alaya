import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { GardenTaskRow } from "@do-soul/alaya-storage";
import { receiveGardenTaskSignals } from "../../garden/post-turn-extract/evidence-finalizer.js";
import type { SignalOutcomeCounter } from "../../garden/post-turn-extract/signal-receiver.js";
import {
  GardenTaskUnavailableError,
  GardenTaskValidationError
} from "../garden-task/garden-task-handler-support.js";
import type { GardenTaskHandlerDependencies } from "../garden-task/garden-task-handlers.js";

interface CandidateSignalEmissionParams {
  readonly deps: GardenTaskHandlerDependencies;
  readonly now: () => string;
}

export async function emitTaskCandidateSignals(
  params: CandidateSignalEmissionParams,
  row: GardenTaskRow,
  candidateSignals: readonly CandidateMemorySignal[],
  completionClaimedBy: string,
  outcomes: SignalOutcomeCounter,
  statementSession = false
): Promise<readonly string[]> {
  if (statementSession) {
    return await receiveGardenTaskSignals({ candidates: candidateSignals,
      signalReceiver: requirePostTurnSignalReceiver(params), outcomes,
      beforeReceive: async () => refreshCompletionClaim(params, row, completionClaimedBy) });
  }
  const emittedSignalIds: string[] = [];
  for (const signal of candidateSignals) {
    const received = await params.deps.signalService.receiveSignal(signal);
    emittedSignalIds.push(received.signal.signal_id);
    outcomes.observe(received);
  }
  return emittedSignalIds;
}

function requirePostTurnSignalReceiver(params: CandidateSignalEmissionParams) {
  const receiver = params.deps.postTurnSignalReceiver;
  if (receiver === undefined) {
    throw new GardenTaskUnavailableError(
      "garden.complete_task cannot receive statement signals without a durable signal receiver."
    );
  }
  return receiver;
}

function refreshCompletionClaim(params: CandidateSignalEmissionParams, row: GardenTaskRow, completionClaimedBy: string): void {
  if (params.deps.gardenTaskRepo!.refreshClaim(row.id, completionClaimedBy, params.now())) return;
  throw new GardenTaskValidationError(
    `Garden task completion claim changed before candidate signal emission: ${row.id}`
  );
}
