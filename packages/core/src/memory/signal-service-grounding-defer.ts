import {
  SignalEventType,
  SignalState,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  readSourceGroundingDeferMeta,
  type SourceGroundingDeferQueuePort,
  type SourceGroundingDeferStats
} from "./source-grounding-defer-queue.js";
import type {
  SignalMaterializationResult,
  SignalServiceEventLogRepoPort,
  SignalServiceWarnPort
} from "./signal-service-types.js";

export async function applySourceGroundingDeferAudit(input: {
  readonly signal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly eventLogRepo: SignalServiceEventLogRepoPort;
  readonly queue: SourceGroundingDeferQueuePort | undefined;
  readonly warn: SignalServiceWarnPort;
  readonly notifyRunBoundEvent: (event: EventLogEntry) => Promise<void>;
}): Promise<void> {
  const meta = readSourceGroundingDeferMeta(input.materialization);
  const deferredEvent = await input.eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
    entity_type: "candidate_memory_signal",
    entity_id: input.signal.signal_id,
    workspace_id: input.signal.workspace_id,
    run_id: input.signal.run_id,
    caused_by: "materialization_router",
    payload_json: SoulSignalTriagedPayloadSchema.parse({
      signal_id: input.signal.signal_id,
      workspace_id: input.signal.workspace_id,
      run_id: input.signal.run_id,
      triage_result: "deferred",
      ...(meta === null
        ? {}
        : { defer_reason: meta.defer_reason, defer_class: meta.defer_class })
    })
  });
  await input.notifyRunBoundEvent(deferredEvent);

  if (meta === null || input.queue === undefined) return;

  const result = input.queue.enqueue({
    signal_id: input.signal.signal_id,
    workspace_id: input.signal.workspace_id,
    run_id: input.signal.run_id,
    defer_reason: meta.defer_reason
  });
  if (result.evicted !== null) {
    input.warn("Source grounding defer queue evicted oldest entry at FIFO cap.", {
      evicted_signal_id: result.evicted.signal_id,
      evicted_defer_reason: result.evicted.defer_reason,
      enqueued_signal_id: input.signal.signal_id
    });
  }
}

export function resolveRedriveSignal(
  existing: CandidateMemorySignal,
  patch?: { readonly raw_payload?: CandidateMemorySignal["raw_payload"] }
): CandidateMemorySignal {
  if (existing.signal_state !== SignalState.DEFERRED) {
    throw new Error(
      `redriveSourceGroundingDefer requires signal_state=deferred, found ${existing.signal_state}`
    );
  }
  if (patch?.raw_payload === undefined) return existing;
  return { ...existing, raw_payload: patch.raw_payload };
}

export function emptySourceGroundingDeferStats(cap: number): SourceGroundingDeferStats {
  return { queue_depth: 0, queue_cap: cap, deferred_by_reason: {} };
}
