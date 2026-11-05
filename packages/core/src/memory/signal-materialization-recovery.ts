import { SignalEventType, SoulSignalMaterializedPayloadSchema, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildSignalWarningMeta } from "./signal-service-helpers.js";
import { readSignalEventsByType } from "./signal-emission-recovery.js";
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
  const [failure] = await readSignalEventsByType(dependencies, signal.signal_id,
    SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED, null, 1);
  const parsed = SoulSignalMaterializedPayloadSchema.safeParse(failure?.payload_json);
  const payload = parsed.success && !parsed.data.success ? parsed.data : null;
  return { signal, triage_result: "accepted", materialization: {
    signal_id: signal.signal_id, target_kind: payload?.target_kind ?? "unknown",
    routing_reason: payload?.routing_reason ?? "persisted_materialization_failure",
    created_objects: payload?.created_objects ?? [], success: false,
    error: payload?.error ?? "A previous materialization failed; inspect its audit for effects."
  } };
}
