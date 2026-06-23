import { SignalKind, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";
import { normalizeTemporalIsoString } from "./temporal-date.js";

const MAX_OFFICIAL_API_SIGNALS = 64;
const MAX_OFFICIAL_API_OBJECT_KIND_CHARS = 200;
const MAX_OFFICIAL_API_MATCHED_TEXT_CHARS = 4_000;
const MAX_OFFICIAL_API_REASON_CHARS = 400;

export interface OfficialApiTemporalProjectionDraft {
  readonly event_time_start?: string;
  readonly event_time_end?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly time_precision?: "day" | "month" | "year" | "range" | "relative" | "unknown";
  readonly time_source?: "explicit" | "session_timestamp" | "relative_resolved";
  readonly projection_schema_version?: 1;
}

export interface OfficialApiPreferenceProfileDraft {
  readonly preference_subject?: string;
  readonly preference_predicate?: string;
  readonly preference_object?: string;
  readonly preference_category?: string;
  readonly preference_polarity?: "positive" | "negative" | "neutral";
  readonly projection_schema_version?: 1;
}

// One parsed signal from the official-API extractor JSON. distilled_fact is
// absent when the model omits it (or supplies a non-string / empty value);
// in that case materialization-router/inputs.ts buildDistilledFact falls through to
// the rule distiller rather than receiving a faked span.
export interface OfficialApiSignalDraft {
  readonly signal_kind: CandidateMemorySignal["signal_kind"];
  readonly object_kind: string;
  readonly confidence: number;
  readonly matched_text: string;
  readonly distilled_fact?: string;
  readonly reason?: string;
  readonly temporal_projection?: OfficialApiTemporalProjectionDraft;
  readonly preference_profile?: OfficialApiPreferenceProfileDraft;
}

// Exported so the LongMemEval bench seed path can drive its ingestion
// through this exact production parse instead of a divergent bench-only
// copy.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
export function parseOfficialApiSignals(content: string): readonly OfficialApiSignalDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    // The whole envelope did not parse. One corrupt `signals[]` entry (a bad
    // `\'` escape, a stray `,""}` empty key, an unescaped inner quote, a
    // malformed key missing `":"`, or a max_tokens-truncated final element)
    // otherwise nukes every clean sibling signal. Degrade element-wise: walk
    // the `signals` array, JSON.parse each `{...}` independently, keep the
    // valid entries, drop the corrupt one(s), and tolerate a truncated final
    // element. This is the array-level analogue of the per-entry drop policy
    // applied below after a successful parse — a sibling's corruption is not
    // allowed to abort the turn's good signals.
    return salvageOfficialApiSignals(content);
  }
  // invariant: a malformed *envelope* (response is not an object, or has no
  // signals array) is a genuine total failure of the extraction call, so it
  // still throws hard. A malformed single *entry* is one bad fact among
  // many — it is dropped, never allowed to abort the turn's good signals.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("signals" in parsed) ||
    !Array.isArray((parsed as { readonly signals?: unknown }).signals)
  ) {
    throw new Error("signals array missing");
  }

  const drafts: OfficialApiSignalDraft[] = [];
  for (const candidate of (parsed as { readonly signals: readonly unknown[] }).signals.slice(
    0,
    MAX_OFFICIAL_API_SIGNALS
  )) {
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  return Object.freeze(drafts);
}

// Element-wise salvage for a `{"signals":[...]}` envelope whose strict
// JSON.parse threw. Reuses parseOfficialApiSignalEntry so every salvaged
// element passes the SAME per-entry validation/drop as the strict path — the
// downstream draft shape is byte-identical. THROWS when zero valid elements
// are recoverable (a degenerate envelope: no `signals` region, or only a
// truncated first/only element) so the caller's existing failure attribution
// (offline_fallbacks + recordExtractionFailureSource) still fires — a corrupt
// degenerate body must NOT masquerade as an empty `{"signals":[]}` extraction.
// see also: salvageRawSignalElements (string-aware balanced-brace walk).
function salvageOfficialApiSignals(content: string): readonly OfficialApiSignalDraft[] {
  const drafts: OfficialApiSignalDraft[] = [];
  for (const element of salvageRawSignalElements(content)) {
    if (drafts.length >= MAX_OFFICIAL_API_SIGNALS) {
      break;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(element) as unknown;
    } catch {
      // A single corrupt element (bad escape / unescaped quote / malformed
      // key) — skip it, keep walking the clean siblings.
      continue;
    }
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  if (drafts.length === 0) {
    throw new Error("signals envelope unparseable and no element recoverable");
  }
  return Object.freeze(drafts);
}

// Walk the `signals` array region of an envelope and return each top-level
// `{...}` element as an independent substring. String-aware (braces inside a
// JSON string literal do not change depth; `\` escapes the next char) so a
// `}` inside `matched_text` never miscounts. A truncated/incomplete FINAL
// element (the array ends before its closing `}`) is dropped — only complete
// balanced elements are returned. Returns [] when no `signals` array region
// is found, so the caller degrades to zero signals (existing fallback).
//
// Exported so the LongMemEval bench seed path can count the RAW salvageable
// element population (lastTurnRawSignalCount) when the strict envelope parse
// fails — otherwise the dropped corrupt entries would vanish from the
// parse-drop attribution instead of landing in parseDropped.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   countRawEnvelopeSignals
export function salvageRawSignalElements(content: string): readonly string[] {
  const signalsKeyIndex = findSignalsArrayStart(content);
  if (signalsKeyIndex < 0) {
    return [];
  }
  const elements: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let elementStart = -1;
  for (let i = signalsKeyIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        elementStart = i;
      }
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && elementStart >= 0) {
          elements.push(content.slice(elementStart, i + 1));
          elementStart = -1;
        }
      }
    } else if (ch === "]" && depth === 0) {
      // Closing the signals array at top level — no in-flight element.
      break;
    }
  }
  // An element still open (depth > 0 / elementStart set) at end-of-buffer is
  // the truncated final element — intentionally NOT pushed.
  return elements;
}

// Find the index of the `[` that opens the `signals` array, scanning past the
// `"signals"` key. String-aware so a `"signals"` substring inside an earlier
// string value is not mistaken for the key. Returns -1 when not found.
function findSignalsArrayStart(content: string): number {
  const keyMatch = /"signals"\s*:\s*\[/u.exec(content);
  if (keyMatch === null) {
    return -1;
  }
  // Position the walk at the `[` so the first `{` after it starts element 0.
  return keyMatch.index + keyMatch[0].length - 1;
}

// Parse one entry of the official-API {"signals":[...]} envelope. Returns
// null — instead of throwing — when the entry is malformed (hallucinated
// signal_kind, missing object_kind / matched_text / confidence, or a
// non-object element), so one bad fact is dropped while the rest survive.
function parseOfficialApiSignalEntry(candidate: unknown): OfficialApiSignalDraft | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }

  const signalKind = normalizeOptionalString((candidate as { readonly signal_kind?: unknown }).signal_kind);
  const objectKind = normalizeOptionalString((candidate as { readonly object_kind?: unknown }).object_kind);
  const matchedText = normalizeOptionalString((candidate as { readonly matched_text?: unknown }).matched_text);
  const distilledFact = normalizeOptionalString((candidate as { readonly distilled_fact?: unknown }).distilled_fact);
  const confidence = (candidate as { readonly confidence?: unknown }).confidence;
  const reason = normalizeOptionalString((candidate as { readonly reason?: unknown }).reason);
  const temporalProjection = normalizeTemporalProjection(
    (candidate as { readonly temporal_projection?: unknown }).temporal_projection
  );
  const preferenceProfile = normalizePreferenceProfile(
    (candidate as { readonly preference_profile?: unknown }).preference_profile
  );

  if (signalKind === null || !isSignalKind(signalKind)) {
    return null;
  }

  if (objectKind === null || matchedText === null || typeof confidence !== "number") {
    return null;
  }

  const clampedMatchedText = matchedText.slice(0, MAX_OFFICIAL_API_MATCHED_TEXT_CHARS);
  // distilled_fact is the resolved one-assertion fact materialization
  // stores as memory_entry content. A model that omits it (or sends a
  // non-string / empty value) leaves the field ABSENT so
  // materialization-router/inputs.ts buildDistilledFact degrades honestly to
  // its rule distiller — never fake one from matched_text. The clamp
  // shares DISTILLED_FACT_MAX_CHARS so the provider and materialization
  // agree on one budget.
  const clampedDistilledFact =
    distilledFact === null ? null : distilledFact.slice(0, DISTILLED_FACT_MAX_CHARS);
  const clampedReason = reason === null ? null : reason.slice(0, MAX_OFFICIAL_API_REASON_CHARS);
  return Object.freeze({
    signal_kind: signalKind,
    object_kind: objectKind.slice(0, MAX_OFFICIAL_API_OBJECT_KIND_CHARS),
    confidence,
    matched_text: clampedMatchedText,
    ...(clampedDistilledFact === null ? {} : { distilled_fact: clampedDistilledFact }),
    ...(clampedReason === null ? {} : { reason: clampedReason }),
    ...(temporalProjection === null ? {} : { temporal_projection: temporalProjection }),
    ...(preferenceProfile === null ? {} : { preference_profile: preferenceProfile })
  });
}

function normalizeTemporalProjection(value: unknown): OfficialApiTemporalProjectionDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const projection: OfficialApiTemporalProjectionDraft = {
    ...readProjectionSchemaVersion(record.projection_schema_version ?? record.version),
    ...readOptionalIsoField(record, "event_time_start"),
    ...readOptionalIsoField(record, "event_time_end"),
    ...readOptionalIsoField(record, "valid_from"),
    ...readOptionalIsoField(record, "valid_to"),
    ...readOptionalTimePrecision(record.time_precision),
    ...readOptionalTimeSource(record.time_source)
  };

  return Object.keys(projection).length === 0 ? null : Object.freeze(projection);
}

function readOptionalIsoField(
  record: Record<string, unknown>,
  key: "event_time_start" | "event_time_end" | "valid_from" | "valid_to"
): Partial<OfficialApiTemporalProjectionDraft> {
  const value = normalizeOptionalString(record[key]);
  if (value === null) {
    return {};
  }
  const normalized = normalizeTemporalIsoString(value);
  return normalized === null ? {} : { [key]: normalized };
}

function readOptionalTimePrecision(
  value: unknown
): Pick<OfficialApiTemporalProjectionDraft, "time_precision"> | Record<string, never> {
  return value === "day" ||
    value === "month" ||
    value === "year" ||
    value === "range" ||
    value === "relative" ||
    value === "unknown"
    ? { time_precision: value }
    : {};
}

function readOptionalTimeSource(
  value: unknown
): Pick<OfficialApiTemporalProjectionDraft, "time_source"> | Record<string, never> {
  return value === "explicit" || value === "session_timestamp" || value === "relative_resolved"
    ? { time_source: value }
    : {};
}

function normalizePreferenceProfile(value: unknown): OfficialApiPreferenceProfileDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const profile: OfficialApiPreferenceProfileDraft = {
    ...readProjectionSchemaVersion(record.projection_schema_version ?? record.version),
    ...readOptionalProfileField(record, "preference_subject", "subject"),
    ...readOptionalProfileField(record, "preference_predicate", "predicate"),
    ...readOptionalProfileField(record, "preference_object", "object"),
    ...readOptionalProfileField(record, "preference_category", "category"),
    ...readOptionalProfilePolarity(record.preference_polarity ?? record.polarity)
  };
  return Object.keys(profile).length === 0 ? null : Object.freeze(profile);
}

function readProjectionSchemaVersion(
  value: unknown
): Pick<OfficialApiTemporalProjectionDraft, "projection_schema_version"> | Record<string, never> {
  return value === 1 ? { projection_schema_version: 1 } : {};
}

function readOptionalProfileField(
  record: Record<string, unknown>,
  outputKey: "preference_subject" | "preference_predicate" | "preference_object" | "preference_category",
  inputKey: "subject" | "predicate" | "object" | "category"
): Partial<OfficialApiPreferenceProfileDraft> {
  const value = normalizeOptionalString(record[outputKey] ?? record[inputKey]);
  return value === null ? {} : { [outputKey]: value.slice(0, 1024) };
}

function readOptionalProfilePolarity(
  value: unknown
): Pick<OfficialApiPreferenceProfileDraft, "preference_polarity"> | Record<string, never> {
  return value === "positive" || value === "negative" || value === "neutral"
    ? { preference_polarity: value }
    : {};
}

export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizePositiveTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

export function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isSignalKind(value: string): value is CandidateMemorySignal["signal_kind"] {
  return (
    value === SignalKind.POTENTIAL_CLAIM ||
    value === SignalKind.POTENTIAL_SYNTHESIS ||
    value === SignalKind.POTENTIAL_HANDOFF ||
    value === SignalKind.POTENTIAL_EVIDENCE_ANCHOR ||
    value === SignalKind.POTENTIAL_CONFLICT ||
    value === SignalKind.POTENTIAL_PREFERENCE
  );
}

export function buildTurnExcerpt(turnContent: string, matchedText: string): string {
  const index = turnContent.indexOf(matchedText);
  if (index < 0) {
    return turnContent.slice(0, 160);
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(turnContent.length, index + matchedText.length + 40);
  return turnContent.slice(start, end).trim();
}

const MAX_FULL_TURN_CONTENT_CHARS = 2_048;

export function clampFullTurnContent(turnContent: string): string {
  return turnContent.slice(0, MAX_FULL_TURN_CONTENT_CHARS);
}
