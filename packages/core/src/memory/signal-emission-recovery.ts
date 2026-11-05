import {
  SignalEventType,
  SignalState,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { requireSignalStateCas } from "./signal-materialization-outcome.js";
import { CoreError } from "../shared/errors.js";
import {
  buildSignalWarningMeta,
  resolveSignalMaterializationContext
} from "./signal-service-helpers.js";
import type {
  SignalMaterializationContext,
  SignalServiceDependencies,
  SignalServiceReceiveResult,
  SignalServiceWarnPort
} from "./signal-service-types.js";

export async function resolveStoredSignalEmissionContext(
  dependencies: Pick<SignalServiceDependencies, "eventLogRepo">,
  signal: CandidateMemorySignal
): Promise<SignalMaterializationContext | null> {
  const emissions = await readSignalEventsByType(dependencies, signal.signal_id,
    SignalEventType.SOUL_SIGNAL_EMITTED, null, 2);
  if (emissions.length !== 1) return null;
  return resolveSignalMaterializationContext(signal, emissions[0]!);
}

export async function readSignalEventsByType(
  dependencies: Pick<SignalServiceDependencies, "eventLogRepo">, signalId: string,
  eventType: string, beforeRevision: number | null, limit: number
): Promise<readonly EventLogEntry[]> {
  const query = dependencies.eventLogRepo.queryByEntityTypeBefore;
  if (query === undefined) throw new CoreError("CONFLICT", "Bounded signal audit query is unavailable.",
    { subCode: "PORT_UNAVAILABLE" });
  return await query.call(dependencies.eventLogRepo, "candidate_memory_signal", signalId, eventType, beforeRevision, limit);
}

export async function deferUnverifiableSignalEmission(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
}): Promise<SignalServiceReceiveResult> {
  const deferredSignal = input.signal.signal_state === SignalState.DEFERRED
    ? input.signal
    : requireSignalStateCas(input.dependencies)({ signalId: input.signal.signal_id,
        workspaceId: input.signal.workspace_id, expectedState: input.signal.signal_state,
        nextState: SignalState.DEFERRED });
  if (deferredSignal === null) throw new CoreError("CONFLICT", "Signal changed before unverifiable-emission deferral.",
    { subCode: "CONCURRENT_MODIFICATION" });
  input.warn(
    "Signal materialization deferred because its immutable admission envelope is missing or mismatched.",
    buildSignalWarningMeta({
      phase: "signal_emission",
      code: "EMISSION_ENVELOPE_UNVERIFIABLE",
      detail: input.signal.signal_id
    })
  );
  return {
    signal: deferredSignal,
    triage_result: "deferred",
    materialization: null
  };
}
