import {
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  SoulSignalNormalizedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { requireSignalStateCas } from "./signal-materialization-outcome.js";
import { CoreError } from "../shared/errors.js";
import {
  buildSignalWarningMeta,
  buildEventLogRawPayloadSummary,
  readSignalRawPayloadDigest,
  resolveSignalMaterializationContext
} from "./signal-service-helpers.js";
import { stableStringify } from "../shared/stable-stringify.js";
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

export async function resolveGroundingRedriveEmissionContext(
  dependencies: Pick<SignalServiceDependencies, "eventLogRepo">,
  signal: CandidateMemorySignal
): Promise<SignalMaterializationContext | null> {
  const emissions = await readSignalEventsByType(dependencies, signal.signal_id,
    SignalEventType.SOUL_SIGNAL_EMITTED, null, 2);
  if (emissions.length !== 1) return null;
  const emission = emissions[0]!;
  const payload = SoulSignalEmittedPayloadSchema.safeParse(emission.payload_json);
  if (!payload.success) return null;
  const context = resolveSignalMaterializationContext(signal, emission, payload.data.raw_payload);
  if (context === null) return null;

  const normalized = await readRedriveNormalizations(dependencies, signal.signal_id, emission.revision);
  let summary = payload.data.raw_payload;
  for (const event of normalized) {
    const parsed = SoulSignalNormalizedPayloadSchema.safeParse(event.payload_json);
    if (!parsed.success) return null;
    const patch = parsed.data.normalized_fields.source_grounding_redrive_patch;
    if (patch === undefined) continue;
    if (event.caused_by !== "operator_redrive" || event.workspace_id !== signal.workspace_id ||
        event.run_id !== signal.run_id || parsed.data.workspace_id !== signal.workspace_id ||
        parsed.data.run_id !== signal.run_id || parsed.data.signal_id !== signal.signal_id ||
        typeof patch !== "object" || patch === null || Array.isArray(patch)) return null;
    const { previous_raw_payload_sha256, changed_field_count, ...next } = patch as Record<string, unknown>;
    const previousDigest = readSignalRawPayloadDigest(summary);
    if (previousDigest === null || previous_raw_payload_sha256 !== previousDigest ||
        readSignalRawPayloadDigest(next) === null || typeof changed_field_count !== "number") return null;
    summary = next;
  }
  return stableStringify(summary) === stableStringify(buildEventLogRawPayloadSummary(signal.raw_payload))
    ? context : null;
}

async function readRedriveNormalizations(
  dependencies: Pick<SignalServiceDependencies, "eventLogRepo">, signalId: string, emittedRevision: number
): Promise<readonly EventLogEntry[]> {
  const events: EventLogEntry[] = [];
  const limit = 64;
  let before: number | null = null;
  while (true) {
    const page = await readSignalEventsByType(dependencies, signalId, SignalEventType.SOUL_SIGNAL_NORMALIZED, before, limit);
    events.push(...page.filter(event => event.revision > emittedRevision));
    const last = page.at(-1);
    if (page.length < limit || last === undefined || last.revision <= emittedRevision) return events.reverse();
    before = last.revision;
  }
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
