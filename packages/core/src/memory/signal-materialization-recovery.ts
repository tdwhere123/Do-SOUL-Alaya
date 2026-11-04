import { SignalState, SignalEventType, SoulSignalNormalizedPayloadSchema, SoulSignalMaterializedPayloadSchema,
  type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildSignalWarningMeta } from "./signal-service-helpers.js";
import { appendMemoryEventLogSynchronously, runEventLogTransaction } from "./memory-service/memory-audit-append.js";
import { bindEventPublisher } from "../runtime/event-publisher.js";
import { requireSignalStateCas } from "./signal-materialization-outcome.js";
import { CoreError } from "../shared/errors.js";
import { readSignalEvents } from "./signal-emission-recovery.js";
import type { SignalServiceDependencies, SignalServiceReceiveResult, SignalServiceWarnPort } from "./signal-service-types.js";

/** A live peer cannot prove that the materializer stopped, even if an old audit exists. */
export async function resumeCompiledSignal(
  _dependencies: SignalServiceDependencies, warn: SignalServiceWarnPort, signal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  warn("Signal replay found a post-triage signal; not replaying materialization side effects.",
    buildSignalWarningMeta({ phase: "signal_replay", code: "POST_TRIAGE_REPLAY_SKIPPED",
      detail: `${signal.signal_id}:${signal.signal_state}` }));
  return { signal, triage_result: "deferred", materialization: null };
}

export async function resumeFailedSignal(
  dependencies: SignalServiceDependencies, signal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const events = [...await readSignalEvents(dependencies, signal.signal_id)]
    .sort((left, right) => right.revision - left.revision);
  const failure = events.find(event => event.event_type === SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED);
  const parsed = SoulSignalMaterializedPayloadSchema.safeParse(failure?.payload_json);
  const payload = parsed.success && !parsed.data.success ? parsed.data : null;
  return { signal, triage_result: "accepted", materialization: {
    signal_id: signal.signal_id, target_kind: payload?.target_kind ?? "unknown",
    routing_reason: payload?.routing_reason ?? "persisted_materialization_failure",
    created_objects: payload?.created_objects ?? [], success: false,
    error: payload?.error ?? "A previous materialization failed; inspect its audit for effects."
  } };
}

/** Logical-id keyset progression survives disposition changes and unreadable retained rows. */
export async function recoverInterruptedMaterialization(
  dependencies: SignalServiceDependencies, warn: SignalServiceWarnPort
): Promise<{ readonly unknown: number; readonly unreadable: number }> {
  const listIds = dependencies.signalRepo.listIdsByStateAfter;
  if (listIds === undefined) throw new CoreError("CONFLICT", "Signal recovery identity query is unavailable.");
  let after: string | null = null, unknown = 0, unreadable = 0;
  for (;;) {
    const ids: readonly string[] = await listIds.call(dependencies.signalRepo, SignalState.COMPILED, after, 100);
    if (ids.length === 0) break;
    for (const id of ids) {
      after = id;
      let signal: CandidateMemorySignal | null;
      try { signal = await dependencies.signalRepo.getById(id); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "VALIDATION_FAILED") throw error;
        unreadable += 1;
        warn("Interrupted signal is unreadable; inspection required.", { signal_id: id });
        continue;
      }
      if (signal === null || signal.signal_state !== SignalState.COMPILED) continue;
      const result = await recordUnknownMaterialization(dependencies, signal);
      if (result.signal.signal_state === SignalState.MATERIALIZATION_UNKNOWN) unknown += 1;
    }
  }
  return { unknown, unreadable };
}

/** Only the daemon's pre-activation runtime-lease owner may invoke this recovery. */
export async function recordUnknownMaterialization(
  dependencies: SignalServiceDependencies, signal: CandidateMemorySignal
): Promise<SignalServiceReceiveResult> {
  const committed = runEventLogTransaction(dependencies.eventLogRepo, () => {
    const event = appendMemoryEventLogSynchronously(dependencies.eventLogRepo, {
      event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED, entity_type: "candidate_memory_signal",
      entity_id: signal.signal_id, workspace_id: signal.workspace_id, run_id: signal.run_id,
      caused_by: "signal_materialization_recovery",
      payload_json: SoulSignalNormalizedPayloadSchema.parse({ signal_id: signal.signal_id,
        workspace_id: signal.workspace_id, run_id: signal.run_id,
        normalized_fields: { materialization_recovery: { disposition: "effects_unknown",
          requires_inspection: true, automatic_replay: false, previous_state: SignalState.COMPILED } } })
    }, "Interrupted materialization recovery requires synchronous audit.");
    const updated = requireSignalStateCas(dependencies)({ signalId: signal.signal_id,
      workspaceId: signal.workspace_id, expectedState: SignalState.COMPILED,
      nextState: SignalState.MATERIALIZATION_UNKNOWN });
    if (updated === null) throw new CoreError("CONFLICT", "Signal changed during quiescent recovery.");
    return { signal: updated, event };
  }, "Interrupted materialization recovery requires a transaction.");
  await bindEventPublisher({ eventLogRepo: dependencies.eventLogRepo,
    runtimeNotifier: dependencies.runtimeNotifier, purpose: "SignalService" }).propagateCommitted([committed.event]);
  return { signal: committed.signal, triage_result: "unknown", materialization: null };
}
