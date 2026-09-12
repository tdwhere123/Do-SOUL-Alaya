import type {
  CandidateMemorySignal,
  ConversationMessage
} from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import { buildGardenTurnEvidenceFallback } from "@do-soul/alaya-soul";
import { buildGardenTaskEvidenceFallbackSignalId } from "../support/task-signal-id.js";
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
  readonly turnMessages: readonly ConversationMessage[];
  readonly sourceObservation: CandidateMemorySignal["source_observation"];
  readonly candidates: readonly CandidateMemorySignal[];
  readonly signalReceiver: PostTurnSignalReceiver;
  readonly admittedSourceRootId?: string;
  readonly beforeReceive?: () => Promise<void>;
}

export async function finalizePostTurnEvidence(
  input: PostTurnEvidenceFinalizationInput
): Promise<readonly string[]> {
  const received = await receiveCandidateSignals(input);
  if (
    input.admittedSourceRootId === undefined &&
    (!received.createdEvidence || !candidatesPreserveOriginalTurn(input))
  ) {
    // The extract-task digest is an 800-char slice. Rebuilding from it would
    // admit a clipped body as if it were the complete original.
    await receiveEvidenceFallback(input, received.signalIds);
  }
  await input.beforeReceive?.();
  return received.signalIds;
}

export async function receivePostTurnCandidates(
  input: PostTurnEvidenceFinalizationInput
): Promise<readonly string[]> {
  const received = await receiveCandidateSignals(input);
  await input.beforeReceive?.();
  return received.signalIds;
}

function candidatesPreserveOriginalTurn(input: PostTurnEvidenceFinalizationInput): boolean {
  return input.candidates.some((candidate) => {
    const payload = candidate.raw_payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    if (typeof record.full_turn_content === "string" && record.full_turn_content === input.turnContent) {
      return true;
    }
    return record.gist === input.turnContent || record.excerpt === input.turnContent;
  });
}

async function receiveCandidateSignals(
  input: PostTurnEvidenceFinalizationInput
): Promise<{ signalIds: string[]; createdEvidence: boolean }> {
  const signalIds: string[] = [];
  let createdEvidence = false;
  for (const candidate of input.candidates) {
    const signal = bindSourceObservation(candidate, input.sourceObservation);
    await input.beforeReceive?.();
    const received = await input.signalReceiver.receiveSignal(signal);
    signalIds.push(received.signal.signal_id);
    createdEvidence ||= receivedEvidenceCapsule(received) ||
      await input.signalReceiver.hasCreatedEvidence(received);
  }
  return { signalIds, createdEvidence };
}

function bindSourceObservation(
  signal: CandidateMemorySignal,
  sourceObservation: CandidateMemorySignal["source_observation"]
): CandidateMemorySignal {
  return sourceObservation === null
    ? signal
    : { ...signal, source_observation: sourceObservation };
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
    sourceObservation: input.sourceObservation,
    turnMessages: input.turnMessages
  });
  if (signal === null) {
    throw new CoreError(
      "VALIDATION",
      `Garden task evidence fallback source content was empty: ${input.taskId}`
    );
  }
  await input.beforeReceive?.();
  const received = await input.signalReceiver.receiveSignal(signal);
  if (!await input.signalReceiver.hasCreatedEvidence(received)) {
    throw new CoreError(
      "VALIDATION",
      `Garden task evidence fallback did not create durable evidence: ${input.taskId}`
    );
  }
  signalIds.push(received.signal.signal_id);
}
