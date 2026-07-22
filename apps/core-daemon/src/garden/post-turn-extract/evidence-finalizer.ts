import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildGardenTurnEvidenceFallback } from "@do-soul/alaya-soul";
import { buildGardenTaskEvidenceFallbackSignalId } from "../task-signal-id.js";
import {
  receivedEvidenceCapsule,
  type PostTurnSignalReceiver
} from "./signal-receiver.js";

export interface PostTurnEvidenceFinalizationInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly turnContent: string;
  readonly sourceObservation: CandidateMemorySignal["source_observation"];
  readonly candidates: readonly CandidateMemorySignal[];
  readonly signalReceiver: PostTurnSignalReceiver;
  readonly beforeReceive?: () => Promise<void>;
}

export async function finalizePostTurnEvidence(
  input: PostTurnEvidenceFinalizationInput
): Promise<readonly string[]> {
  const received = await receiveCandidateSignals(input);
  if (!received.createdEvidence) {
    await receiveEvidenceFallback(input, received.signalIds);
  }
  await input.beforeReceive?.();
  return received.signalIds;
}

async function receiveCandidateSignals(
  input: PostTurnEvidenceFinalizationInput
): Promise<{ signalIds: string[]; createdEvidence: boolean }> {
  const signalIds: string[] = [];
  let createdEvidence = false;
  for (const signal of input.candidates) {
    await input.beforeReceive?.();
    const received = await input.signalReceiver.receiveSignal(signal);
    signalIds.push(received.signal.signal_id);
    createdEvidence ||= receivedEvidenceCapsule(received) ||
      await input.signalReceiver.hasCreatedEvidence(received);
  }
  return { signalIds, createdEvidence };
}

async function receiveEvidenceFallback(
  input: PostTurnEvidenceFinalizationInput,
  signalIds: string[]
): Promise<void> {
  const signal = buildGardenTurnEvidenceFallback({
    turnContent: input.turnContent,
    reason: input.candidates.length === 0 ? "empty_extraction" : "no_evidence_created",
    signalId: buildGardenTaskEvidenceFallbackSignalId(input.taskId),
    workspaceId: input.workspaceId,
    runId: input.runId,
    surfaceId: null,
    createdAt: input.createdAt,
    sourceObservation: input.sourceObservation
  });
  if (signal === null) {
    throw new Error(`Garden task ${input.taskId} evidence fallback source content was empty.`);
  }
  await input.beforeReceive?.();
  const received = await input.signalReceiver.receiveSignal(signal);
  if (!await input.signalReceiver.hasCreatedEvidence(received)) {
    throw new Error(`Garden task ${input.taskId} evidence fallback did not create durable evidence.`);
  }
  signalIds.push(received.signal.signal_id);
}
