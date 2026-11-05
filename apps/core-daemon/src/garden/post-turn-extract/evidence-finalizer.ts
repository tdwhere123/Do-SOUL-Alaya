import {
  CandidateMemorySignalSchema,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  isWritePathMaterializationDeferral,
  type SignalOutcomeCounter,
  type PostTurnSignalReceiver
} from "./signal-receiver.js";

type GardenTaskSignalReceiptInput = Readonly<{
  readonly candidates: readonly CandidateMemorySignal[];
  readonly signalReceiver: PostTurnSignalReceiver;
  readonly beforeReceive?: () => Promise<void>;
  readonly outcomes?: SignalOutcomeCounter;
}>;

/** Durable receipt of task-produced signals under a claim; no turn evidence fallback is involved. */
export async function receiveGardenTaskSignals(input: GardenTaskSignalReceiptInput): Promise<readonly string[]> {
  const signalIds: string[] = [];
  for (const candidate of input.candidates) {
    const signal = bindSourceObservation(candidate);
    await input.beforeReceive?.();
    let received = await input.signalReceiver.receiveSignal(signal);
    if (isWritePathMaterializationDeferral(received)) {
      await input.beforeReceive?.();
      received = await input.signalReceiver.receiveSignal(signal);
    }
    signalIds.push(received.signal.signal_id);
    input.outcomes?.observe(received);
  }
  await input.beforeReceive?.();
  return signalIds;
}

function bindSourceObservation(signal: CandidateMemorySignal): CandidateMemorySignal {
  if (signal.interpretation_contract !== undefined) return signal;
  return CandidateMemorySignalSchema.parse({ ...signal, source_observation: null });
}
