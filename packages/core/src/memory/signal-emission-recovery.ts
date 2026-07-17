import {
  SignalEventType,
  SignalState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
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
  const entries = await dependencies.eventLogRepo.queryByEntity(
    "candidate_memory_signal",
    signal.signal_id
  );
  const emissions = entries.filter(
    (entry) => entry.event_type === SignalEventType.SOUL_SIGNAL_EMITTED
  );
  if (emissions.length !== 1) return null;
  return resolveSignalMaterializationContext(signal, emissions[0]!);
}

export async function deferUnverifiableSignalEmission(input: {
  readonly dependencies: SignalServiceDependencies;
  readonly warn: SignalServiceWarnPort;
  readonly signal: CandidateMemorySignal;
}): Promise<SignalServiceReceiveResult> {
  const deferredSignal = input.signal.signal_state === SignalState.DEFERRED
    ? input.signal
    : await input.dependencies.signalRepo.updateState(input.signal.signal_id, SignalState.DEFERRED);
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
