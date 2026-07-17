import { createHash } from "node:crypto";
import {
  AlayaError,
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry,
  type SignalState as SignalStateValue
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../shared/stable-stringify.js";
import type {
  SignalEmittedEventInput,
  SignalMaterializationContext,
  SignalTriageResult
} from "./signal-service-types.js";

const RAW_PAYLOAD_REDACTED_KEY = "raw_payload_redacted";
const RAW_PAYLOAD_SHA256_KEY = "raw_payload_sha256";
const RAW_PAYLOAD_KEY_COUNT_KEY = "raw_payload_key_count";
const BENCH_SEED_MARKER_KEY = "bench_seed";
const BENCH_TURN_SEED_INDEX_KEY = "bench_turn_seed_index";
const BENCH_SUMMARY_SEED_MARKER_KEY = "bench_summary_seeded";
const BENCH_SUMMARY_TURN_SEED_INDEX_KEY = "bench_summary_turn_seed_index";
const BENCH_FULL_TURN_CONTENT_KEY = "bench_full_turn_content";
const BENCH_STORED_CONTENT_KEY = "bench_stored_content";
const BENCH_FULL_TURN_TOKENS_KEY = "bench_full_turn_tokens";
const BENCH_STORED_CONTENT_TOKENS_KEY = "bench_stored_content_tokens";
const BENCH_FULL_TURN_CHAR_COUNT_KEY = "bench_full_turn_char_count";
const BENCH_FULL_TURN_SHA256_KEY = "bench_full_turn_sha256";
const BENCH_TOKEN_CHARS_PER_TOKEN = 4;

export function mapTriageResultToSignalState(
  triageResult: SignalTriageResult
): SignalStateValue {
  switch (triageResult) {
    case "accepted":
      return SignalState.TRIAGED;
    case "deferred":
      return SignalState.DEFERRED;
    case "dropped":
      return SignalState.DROPPED;
    default: {
      const exhaustiveCheck: never = triageResult;
      return exhaustiveCheck;
    }
  }
}

export function mapExistingSignalStateToTriage(
  state: SignalStateValue
): SignalTriageResult {
  switch (state) {
    case SignalState.DROPPED:
      return "dropped";
    case SignalState.DEFERRED:
      return "deferred";
    default:
      return "accepted";
  }
}

export function assertReplayMatchesExistingSignal(
  existingSignal: CandidateMemorySignal,
  incomingSignal: CandidateMemorySignal
): void {
  if (buildSignalReplayFingerprint(existingSignal) !== buildSignalReplayFingerprint(incomingSignal)) {
    throw new SignalReplayMismatchError(
      `Candidate signal replay does not match existing signal content: ${incomingSignal.signal_id}`
    );
  }
}

export function buildEventLogRawPayloadSummary(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Record<string, unknown> {
  return {
    [RAW_PAYLOAD_REDACTED_KEY]: true,
    [RAW_PAYLOAD_SHA256_KEY]: `sha256:${createHash("sha256")
      .update(stableStringify(rawPayload), "utf8")
      .digest("hex")}`,
    [RAW_PAYLOAD_KEY_COUNT_KEY]: Object.keys(rawPayload).length,
    ...buildBenchTokenPayloadSummary(rawPayload)
  };
}

export function buildSignalEmittedEventInput(
  signal: CandidateMemorySignal
): SignalEmittedEventInput {
  return {
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: signal.source,
    payload_json: SoulSignalEmittedPayloadSchema.parse({
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      source: signal.source,
      signal_kind: signal.signal_kind,
      ...(signal.source_delivery_ids === undefined
        ? {}
        : { source_delivery_ids: signal.source_delivery_ids }),
      source_observation: signal.source_observation ?? null,
      source_memory_refs: signal.source_memory_refs,
      supersedes_refs: signal.supersedes_refs,
      exception_to_refs: signal.exception_to_refs,
      contradicts_refs: signal.contradicts_refs,
      incompatible_with_refs: signal.incompatible_with_refs,
      raw_payload: buildEventLogRawPayloadSummary(signal.raw_payload)
    })
  };
}

/**
 * Replays are allowed to materialize only when their immutable admission
 * envelope is unique and canonically equal to the persisted signal. The
 * trusted source receipt, not EventLog creation time, supplies temporal time.
 */
export function resolveSignalMaterializationContext(
  signal: CandidateMemorySignal,
  event: EventLogEntry
): SignalMaterializationContext | null {
  const expected = buildSignalEmittedEventInput(signal);
  if (
    event.event_type !== SignalEventType.SOUL_SIGNAL_EMITTED ||
    event.entity_type !== expected.entity_type ||
    event.entity_id !== expected.entity_id ||
    event.workspace_id !== expected.workspace_id ||
    event.run_id !== expected.run_id ||
    event.caused_by !== expected.caused_by
  ) {
    return null;
  }

  try {
    const actualPayload = SoulSignalEmittedPayloadSchema.parse(event.payload_json);
    if (stableStringify(actualPayload) !== stableStringify(expected.payload_json)) {
      return null;
    }
  } catch {
    return null;
  }

  const sourceObservation = signal.source_observation ?? null;
  if (sourceObservation === null) {
    return { source_event_anchor: null };
  }
  return {
    source_event_anchor: {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      event_id: event.event_id,
      occurred_at: sourceObservation.observed_at
    }
  };
}

export function hashAuditText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function buildSignalWarningMeta(input: {
  readonly phase:
    | "signal_replay"
    | "signal_emission"
    | "materialization"
    | "event_notification"
    | "source_grounding_redrive"
    | "source_grounding_defer_queue";
  readonly code:
    | "POST_TRIAGE_REPLAY_SKIPPED"
    | "EMISSION_ENVELOPE_UNVERIFIABLE"
    | "MATERIALIZER_THROW"
    | "MATERIALIZATION_UNSUCCESSFUL"
    | "RUNTIME_NOTIFY_FAILED"
    | "REDRIVE_UNCERTAIN"
    | "FIFO_EVICTION";
  readonly detail?: string;
  readonly itemCount?: number;
}): Record<string, unknown> {
  return {
    phase: input.phase,
    code: input.code,
    ...(input.detail === undefined ? {} : {
      detail_sha256: hashAuditText(input.detail),
      detail_char_count: input.detail.length
    }),
    ...(input.itemCount === undefined ? {} : { item_count: input.itemCount })
  };
}

export function hasInvalidSchemaGrounding(
  signal: CandidateMemorySignal
): boolean {
  const rawPayload = signal.raw_payload;
  if (
    rawPayload.schema_grounding === undefined &&
    rawPayload.detected_object === undefined &&
    rawPayload.field_candidates === undefined &&
    rawPayload.validation_result === undefined
  ) {
    return false;
  }

  const detectedObject = readRecord(rawPayload.detected_object);
  const detectedObjectKind = readNonEmptyString(detectedObject?.object_kind);
  if (detectedObjectKind !== signal.object_kind) {
    return true;
  }

  const fields = Array.isArray(rawPayload.field_candidates)
    ? rawPayload.field_candidates
    : [];
  if (fields.length === 0) {
    return true;
  }

  for (const field of fields) {
    const record = readRecord(field);
    if (
      record === null ||
      readNonEmptyString(record.field_name) === null ||
      readNonEmptyString(record.value) === null ||
      readNonEmptyString(record.evidence) === null
    ) {
      return true;
    }
  }

  const validationResult = readRecord(rawPayload.validation_result);
  const validationStatus = readNonEmptyString(validationResult?.status);
  return validationStatus !== "valid";
}

export function evaluateSignalTriage(signal: CandidateMemorySignal): SignalTriageResult {
  if (hasInvalidSchemaGrounding(signal)) return "deferred";
  if (signal.confidence < 0.3 && signal.signal_kind === "potential_conflict") return "deferred";
  // Signals below this evidence/confidence floor stay out of the durable path;
  // higher-confidence heuristic signals may still become questionable evidence.
  return signal.evidence_refs.length === 0 && signal.confidence < 0.4 ? "deferred" : "accepted";
}

function buildSignalReplayFingerprint(signal: CandidateMemorySignal): string {
  return stableStringify({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    source: signal.source,
    signal_kind: signal.signal_kind,
    object_kind: signal.object_kind,
    scope_hint: signal.scope_hint,
    domain_tags: signal.domain_tags,
    confidence: signal.confidence,
    evidence_refs: signal.evidence_refs,
    source_memory_refs: signal.source_memory_refs,
    supersedes_refs: signal.supersedes_refs,
    exception_to_refs: signal.exception_to_refs,
    contradicts_refs: signal.contradicts_refs,
    incompatible_with_refs: signal.incompatible_with_refs,
    raw_payload: signal.raw_payload,
    source_delivery_ids: signal.source_delivery_ids,
    // Older rows predate the nullable receipt column. Treat their missing field
    // as the same untrusted state as the schema's persisted default.
    source_observation: signal.source_observation ?? null
  });
}

function buildBenchTokenPayloadSummary(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Record<string, unknown> {
  if (rawPayload[BENCH_SEED_MARKER_KEY] !== true) {
    return {};
  }

  const summary: Record<string, unknown> = {
    [BENCH_SUMMARY_SEED_MARKER_KEY]: true
  };
  const turnSeedIndex = rawPayload[BENCH_TURN_SEED_INDEX_KEY];
  if (typeof turnSeedIndex === "number" && Number.isFinite(turnSeedIndex)) {
    summary[BENCH_SUMMARY_TURN_SEED_INDEX_KEY] = turnSeedIndex;
  }

  const excerptSibling = readNonEmptyString(rawPayload.excerpt);
  const fullTurnContent =
    readNonEmptyString(rawPayload.full_turn_content) ??
    readNonEmptyString(rawPayload[BENCH_FULL_TURN_CONTENT_KEY]) ??
    excerptSibling;
  const storedContent =
    readNonEmptyString(rawPayload[BENCH_STORED_CONTENT_KEY]) ??
    readNonEmptyString(rawPayload.distilled_fact) ??
    excerptSibling;
  const projectedFullTurnTokens = readNonNegativeInteger(
    rawPayload[BENCH_FULL_TURN_TOKENS_KEY]
  );
  const projectedStoredContentTokens = readNonNegativeInteger(
    rawPayload[BENCH_STORED_CONTENT_TOKENS_KEY]
  );
  const fullTurnTokens =
    projectedFullTurnTokens ??
    (fullTurnContent === null ? null : estimateBenchTokens(fullTurnContent));
  const storedContentTokens =
    projectedStoredContentTokens ??
    (storedContent === null ? null : estimateBenchTokens(storedContent));

  if (fullTurnTokens !== null) {
    summary[BENCH_FULL_TURN_TOKENS_KEY] = fullTurnTokens;
  }
  if (storedContentTokens !== null) {
    summary[BENCH_STORED_CONTENT_TOKENS_KEY] = storedContentTokens;
  }
  copyFullTurnIdentity(summary, rawPayload);

  return summary;
}

function copyFullTurnIdentity(
  summary: Record<string, unknown>,
  rawPayload: CandidateMemorySignal["raw_payload"]
): void {
  const charCount = readNonNegativeInteger(rawPayload[BENCH_FULL_TURN_CHAR_COUNT_KEY]);
  const digest = rawPayload[BENCH_FULL_TURN_SHA256_KEY];
  if (charCount !== null) summary[BENCH_FULL_TURN_CHAR_COUNT_KEY] = charCount;
  if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)) {
    summary[BENCH_FULL_TURN_SHA256_KEY] = digest;
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function estimateBenchTokens(text: string): number {
  return Math.ceil(text.length / BENCH_TOKEN_CHARS_PER_TOKEN);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

class SignalReplayMismatchError extends AlayaError {
  public constructor(message: string) {
    super("VALIDATION", message);
    this.name = "SignalReplayMismatchError";
  }
}
