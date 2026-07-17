import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { EventPublisher } from "../runtime/event-publisher.js";
import { assertReplayMatchesExistingSignal } from "./signal-service-helpers.js";
import type {
  SignalEmittedEventInput,
  SignalEmissionReceipt,
  SignalServiceAtomicSignalRepoPort,
  SignalServiceEmissionWriterPort
} from "./signal-service-types.js";

export function createSignalEmissionWriter(input: {
  readonly eventPublisher: EventPublisher;
  readonly signalRepo: SignalServiceAtomicSignalRepoPort;
}): SignalServiceEmissionWriterPort {
  assertSharedTransactionBoundary(input.eventPublisher, input.signalRepo);

  return {
    emit: async (
      signal: CandidateMemorySignal,
      event: SignalEmittedEventInput
    ): Promise<SignalEmissionReceipt> =>
      await input.eventPublisher.decideAppendThenApply(() => {
        const existing = input.signalRepo.getByIdInCurrentTransaction(signal.signal_id);
        if (existing !== null) {
          assertReplayMatchesExistingSignal(existing, signal);
          return {
            eventInputs: [],
            apply: (): SignalEmissionReceipt => ({ signal: existing, emitted_event: null })
          };
        }

        return {
          eventInputs: [event],
          apply: (entries): SignalEmissionReceipt => {
            const emittedEvent = entries[0];
            if (emittedEvent === undefined) {
              throw new CoreError("CONFLICT", "Signal admission did not receive its EventLog envelope.");
            }
            return {
              signal: input.signalRepo.createInCurrentTransaction(signal),
              emitted_event: emittedEvent
            };
          }
        };
      })
  };
}

function assertSharedTransactionBoundary(
  eventPublisher: EventPublisher,
  signalRepo: SignalServiceAtomicSignalRepoPort
): void {
  const eventConnection = eventPublisher.getStorageConnectionIdentity();
  const signalConnection = signalRepo.getStorageConnectionIdentity();
  if (eventConnection === undefined || eventConnection !== signalConnection) {
    throw new CoreError(
      "CONFLICT",
      "Signal EventLog admission and signal persistence must share one SQLite transaction boundary.",
      { subCode: "PORT_UNAVAILABLE" }
    );
  }
}
