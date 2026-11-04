import { SignalEventType, SoulSignalTriagedPayloadSchema, type CandidateMemorySignal,
  type EventLogEntry } from "@do-soul/alaya-protocol";
import { requireSignalStateCas } from "./signal-materialization-outcome.js";
import { appendMemoryEventLogSynchronously, runEventLogTransaction } from "./memory-service/memory-audit-append.js";
import type { SignalServiceDependencies, SignalTriageResult } from "./signal-service-types.js";

class TriageClaimLost extends Error {}

/** Stale EMITTED snapshots cannot overwrite a live COMPILED or terminal signal. */
export function persistTriagedSignal(
  dependencies: SignalServiceDependencies,
  signal: CandidateMemorySignal,
  nextState: CandidateMemorySignal["signal_state"],
  triageResult: SignalTriageResult
): { readonly triagedEvent: EventLogEntry; readonly triagedSignal: CandidateMemorySignal } | null {
  const cas = requireSignalStateCas(dependencies);
  try {
    return runEventLogTransaction(dependencies.eventLogRepo, () => {
      const triagedEvent = appendMemoryEventLogSynchronously(dependencies.eventLogRepo, {
        event_type: SignalEventType.SOUL_SIGNAL_TRIAGED, entity_type: "candidate_memory_signal",
        entity_id: signal.signal_id, workspace_id: signal.workspace_id, run_id: signal.run_id,
        caused_by: "deterministic_rule", payload_json: SoulSignalTriagedPayloadSchema.parse({
          signal_id: signal.signal_id, workspace_id: signal.workspace_id, run_id: signal.run_id,
          triage_result: triageResult
        })
      }, "Signal triage requires synchronous audit.");
      const triagedSignal = cas({ signalId: signal.signal_id, workspaceId: signal.workspace_id,
        expectedState: signal.signal_state, nextState });
      if (triagedSignal === null) throw new TriageClaimLost();
      return { triagedEvent, triagedSignal };
    }, "Signal triage requires a transaction.");
  } catch (error) {
    if (error instanceof TriageClaimLost) return null;
    throw error;
  }
}
