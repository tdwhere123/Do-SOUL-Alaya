import { SignalState, type CandidateMemorySignal, type EventLogEntry } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { bindEventPublisher } from "../runtime/event-publisher.js";
import { appendMemoryEventLogSynchronously, runEventLogTransaction } from "./memory-service/memory-audit-append.js";
import { buildSignalMaterializationEvent, resolveSignalMaterializationDisposition } from "./signal-service-helpers.js";
import type { SignalMaterializationResult, SignalServiceDependencies, SignalServiceReceiveResult,
  SignalServiceStateCasInput } from "./signal-service-types.js";

/** New outcomes have no audit/state gap. Historical ambiguous audits are never completion witnesses. */
export async function commitSignalMaterializationOutcome(
  dependencies: SignalServiceDependencies,
  signal: CandidateMemorySignal,
  materialization: SignalMaterializationResult,
  additionalEvents: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[] = []
): Promise<SignalServiceReceiveResult> {
  const nextState = resolveSignalMaterializationDisposition(materialization);
  const committed = runEventLogTransaction(dependencies.eventLogRepo, () => {
    const events = [buildSignalMaterializationEvent(signal, materialization), ...additionalEvents]
      .map(event => appendMemoryEventLogSynchronously(dependencies.eventLogRepo, event,
        "Materialization outcome requires synchronous audit."));
    const updated = requireSignalStateCas(dependencies)({ signalId: signal.signal_id,
      workspaceId: signal.workspace_id, expectedState: SignalState.COMPILED, nextState });
    if (updated === null) throw new CoreError("CONFLICT", "Materialization outcome lost its compiled fence.",
      { subCode: "CONCURRENT_MODIFICATION" });
    return { events, signal: updated };
  }, "Materialization outcome requires a shared transaction.");
  await bindEventPublisher({ eventLogRepo: dependencies.eventLogRepo,
    runtimeNotifier: dependencies.runtimeNotifier, purpose: "SignalService" }).propagateCommitted(committed.events);
  return { signal: committed.signal, triage_result: nextState === SignalState.DEFERRED ? "deferred" : "accepted",
    materialization };
}

export function requireSignalStateCas(dependencies: SignalServiceDependencies):
(input: SignalServiceStateCasInput) => CandidateMemorySignal | null {
  const cas = dependencies.signalRepo.compareAndSwapState;
  if (cas === undefined) throw new CoreError("CONFLICT", "Signal materialization CAS port is not available",
    { subCode: "PORT_UNAVAILABLE" });
  return input => cas.call(dependencies.signalRepo, input);
}
