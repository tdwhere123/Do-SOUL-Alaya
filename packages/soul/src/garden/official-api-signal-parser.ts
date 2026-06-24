import { z } from "zod";
import { SignalKind, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";
import { normalizeTemporalIsoString } from "./temporal-date.js";

const MAX_OFFICIAL_API_SIGNALS = 64;
const MAX_OFFICIAL_API_OBJECT_KIND_CHARS = 200;
const MAX_OFFICIAL_API_MATCHED_TEXT_CHARS = 4_000;
const MAX_OFFICIAL_API_REASON_CHARS = 400;
const UnknownRecordSchema = z.record(z.string(), z.unknown()).readonly();
const OfficialApiSignalsEnvelopeSchema = z.object({
  signals: z.array(z.unknown()).readonly()
}).passthrough().readonly();

const RequiredTrimmedStringSchema = z.preprocess(normalizeStringValue, z.string().min(1));
const OptionalTrimmedStringSchema = z
  .preprocess(normalizeStringValue, z.string().min(1).nullable())
  .transform((value) => value ?? null);
const OfficialApiSignalKindSchema = z.preprocess(
  normalizeStringValue,
  z.union([
    z.literal(SignalKind.POTENTIAL_CLAIM),
    z.literal(SignalKind.POTENTIAL_SYNTHESIS),
    z.literal(SignalKind.POTENTIAL_HANDOFF),
    z.literal(SignalKind.POTENTIAL_EVIDENCE_ANCHOR),
    z.literal(SignalKind.POTENTIAL_CONFLICT),
    z.literal(SignalKind.POTENTIAL_PREFERENCE)
  ])
);
const StringArraySchema = z
  .preprocess((value) => (Array.isArray(value) ? value : []), z.array(OptionalTrimmedStringSchema))
  .transform((values) => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      if (value === null || seen.has(value)) {
        continue;
      }
      seen.add(value);
      output.push(value);
    }
    return Object.freeze(output);
  });
const OptionalProjectionSchemaVersionSchema = z.preprocess(
  (value) => (value === 1 ? value : undefined),
  z.literal(1).optional()
);
const OptionalIsoStringSchema = z.preprocess((value) => {
  const normalized = normalizeStringValue(value);
  return normalized === null ? undefined : normalizeTemporalIsoString(normalized) ?? undefined;
}, z.string().optional());
const TimePrecisionValueSchema = z.union([
  z.literal("day"),
  z.literal("month"),
  z.literal("year"),
  z.literal("range"),
  z.literal("relative"),
  z.literal("unknown")
]);
const OptionalTimePrecisionSchema = z.preprocess((value) => {
  const parsed = TimePrecisionValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, TimePrecisionValueSchema.optional());
const TimeSourceValueSchema = z.union([
  z.literal("explicit"),
  z.literal("session_timestamp"),
  z.literal("relative_resolved")
]);
const OptionalTimeSourceSchema = z.preprocess((value) => {
  const parsed = TimeSourceValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, TimeSourceValueSchema.optional());
const OfficialApiTemporalProjectionSchema = z
  .preprocess(normalizeTemporalProjectionInput, z.object({
    projection_schema_version: OptionalProjectionSchemaVersionSchema,
    event_time_start: OptionalIsoStringSchema,
    event_time_end: OptionalIsoStringSchema,
    valid_from: OptionalIsoStringSchema,
    valid_to: OptionalIsoStringSchema,
    time_precision: OptionalTimePrecisionSchema,
    time_source: OptionalTimeSourceSchema
  }).nullable())
  .transform((projection): OfficialApiTemporalProjectionDraft | null => {
    if (projection === null) {
      return null;
    }
    const draft: OfficialApiTemporalProjectionDraft = {
      ...(projection.projection_schema_version === undefined
        ? {}
        : { projection_schema_version: projection.projection_schema_version }),
      ...(projection.event_time_start === undefined ? {} : { event_time_start: projection.event_time_start }),
      ...(projection.event_time_end === undefined ? {} : { event_time_end: projection.event_time_end }),
      ...(projection.valid_from === undefined ? {} : { valid_from: projection.valid_from }),
      ...(projection.valid_to === undefined ? {} : { valid_to: projection.valid_to }),
      ...(projection.time_precision === undefined ? {} : { time_precision: projection.time_precision }),
      ...(projection.time_source === undefined ? {} : { time_source: projection.time_source })
    };
    return Object.keys(draft).length === 0 ? null : Object.freeze(draft);
  });
const PreferencePolarityValueSchema = z.union([
  z.literal("positive"),
  z.literal("negative"),
  z.literal("neutral")
]);
const OptionalPreferencePolaritySchema = z.preprocess((value) => {
  const parsed = PreferencePolarityValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, PreferencePolarityValueSchema.optional());
const OptionalProfileFieldSchema = z
  .preprocess((value) => normalizeStringValue(value) ?? undefined, z.string().min(1).optional())
  .transform((value) => (value === undefined ? undefined : value.slice(0, 1024)));
const OfficialApiPreferenceProfileSchema = z
  .preprocess(normalizePreferenceProfileInput, z.object({
    projection_schema_version: OptionalProjectionSchemaVersionSchema,
    preference_subject: OptionalProfileFieldSchema,
    preference_predicate: OptionalProfileFieldSchema,
    preference_object: OptionalProfileFieldSchema,
    preference_category: OptionalProfileFieldSchema,
    preference_polarity: OptionalPreferencePolaritySchema
  }).nullable())
  .transform((profile): OfficialApiPreferenceProfileDraft | null => {
    if (profile === null) {
      return null;
    }
    const draft: OfficialApiPreferenceProfileDraft = {
      ...(profile.projection_schema_version === undefined
        ? {}
        : { projection_schema_version: profile.projection_schema_version }),
      ...(profile.preference_subject === undefined ? {} : { preference_subject: profile.preference_subject }),
      ...(profile.preference_predicate === undefined ? {} : { preference_predicate: profile.preference_predicate }),
      ...(profile.preference_object === undefined ? {} : { preference_object: profile.preference_object }),
      ...(profile.preference_category === undefined ? {} : { preference_category: profile.preference_category }),
      ...(profile.preference_polarity === undefined ? {} : { preference_polarity: profile.preference_polarity })
    };
    return Object.keys(draft).length === 0 ? null : Object.freeze(draft);
  });
const OfficialApiSignalEntrySchema = z.object({
  signal_kind: OfficialApiSignalKindSchema,
  object_kind: RequiredTrimmedStringSchema,
  confidence: z.number(),
  matched_text: RequiredTrimmedStringSchema,
  evidence_refs: StringArraySchema,
  source_memory_refs: StringArraySchema,
  distilled_fact: OptionalTrimmedStringSchema,
  reason: OptionalTrimmedStringSchema,
  temporal_projection: OfficialApiTemporalProjectionSchema,
  preference_profile: OfficialApiPreferenceProfileSchema
}).passthrough().readonly();

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
  readonly evidence_refs: readonly string[];
  readonly source_memory_refs: readonly string[];
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
    parsed = JSON.parse(content);
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
  const envelope = OfficialApiSignalsEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new Error("signals array missing");
  }

  const drafts: OfficialApiSignalDraft[] = [];
  for (const candidate of envelope.data.signals.slice(0, MAX_OFFICIAL_API_SIGNALS)) {
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
      candidate = JSON.parse(element);
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
  const parsed = OfficialApiSignalEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data;

  const clampedMatchedText = record.matched_text.slice(0, MAX_OFFICIAL_API_MATCHED_TEXT_CHARS);
  // distilled_fact is the resolved one-assertion fact materialization
  // stores as memory_entry content. A model that omits it (or sends a
  // non-string / empty value) leaves the field ABSENT so
  // materialization-router/inputs.ts buildDistilledFact degrades honestly to
  // its rule distiller — never fake one from matched_text. The clamp
  // shares DISTILLED_FACT_MAX_CHARS so the provider and materialization
  // agree on one budget.
  const clampedDistilledFact =
    record.distilled_fact === null ? null : record.distilled_fact.slice(0, DISTILLED_FACT_MAX_CHARS);
  const clampedReason = record.reason === null ? null : record.reason.slice(0, MAX_OFFICIAL_API_REASON_CHARS);
  return Object.freeze({
    signal_kind: record.signal_kind,
    object_kind: record.object_kind.slice(0, MAX_OFFICIAL_API_OBJECT_KIND_CHARS),
    confidence: record.confidence,
    matched_text: clampedMatchedText,
    evidence_refs: record.evidence_refs,
    source_memory_refs: record.source_memory_refs,
    ...(clampedDistilledFact === null ? {} : { distilled_fact: clampedDistilledFact }),
    ...(clampedReason === null ? {} : { reason: clampedReason }),
    ...(record.temporal_projection === null ? {} : { temporal_projection: record.temporal_projection }),
    ...(record.preference_profile === null ? {} : { preference_profile: record.preference_profile })
  });
}

function normalizeTemporalProjectionInput(value: unknown): unknown {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data;
  return {
    projection_schema_version: record.projection_schema_version ?? record.version,
    event_time_start: record.event_time_start,
    event_time_end: record.event_time_end,
    valid_from: record.valid_from,
    valid_to: record.valid_to,
    time_precision: record.time_precision,
    time_source: record.time_source
  };
}

function normalizePreferenceProfileInput(value: unknown): unknown {
  const parsed = UnknownRecordSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data;
  return {
    projection_schema_version: record.projection_schema_version ?? record.version,
    preference_subject: record.preference_subject ?? record.subject,
    preference_predicate: record.preference_predicate ?? record.predicate,
    preference_object: record.preference_object ?? record.object,
    preference_category: record.preference_category ?? record.category,
    preference_polarity: record.preference_polarity ?? record.polarity
  };
}

export function normalizeOptionalString(value: unknown): string | null {
  return normalizeStringValue(value);
}

function normalizeStringValue(value: unknown): string | null {
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
