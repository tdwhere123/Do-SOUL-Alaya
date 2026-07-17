import { z } from "zod";
import { SignalKind, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";
import {
  parseOfficialApiTemporalProjection,
  type OfficialApiTemporalProjectionDraft
} from "./temporal/observed-projection.js";

export const OFFICIAL_API_SIGNAL_LIMIT = 64;
// invariant: C0 cache reuse binds this parser behavior explicitly rather than
// inferring compatibility from raw cache identity alone.
export const OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION = "official-api-signal-parser-v1";
const MAX_OFFICIAL_API_OBJECT_KIND_CHARS = 200;
const MAX_OFFICIAL_API_MATCHED_TEXT_CHARS = 4_000;
const MAX_OFFICIAL_API_REASON_CHARS = 400;
const UnknownRecordSchema = z.record(z.string(), z.unknown()).readonly();
const OfficialApiSignalsEnvelopeSchema = z.object({
  signals: z.array(z.unknown()).readonly()
}).loose().readonly();

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
const MAX_CANONICAL_ENTITIES = 3;
// canonical_entities is the answer-selective key: normalize to lowercase, dedupe, cap 3.
const CanonicalEntitiesArraySchema = z
  .preprocess((value) => (Array.isArray(value) ? value : []), z.array(OptionalTrimmedStringSchema))
  .transform((values) => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      if (value === null) {
        continue;
      }
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
      if (output.length >= MAX_CANONICAL_ENTITIES) {
        break;
      }
    }
    return Object.freeze(output);
  });
const OptionalProjectionSchemaVersionSchema = z.preprocess(
  (value) => (value === 1 ? value : undefined),
  z.literal(1).optional()
);
const OfficialApiTemporalProjectionSchema = z.preprocess(
  parseOfficialApiTemporalProjection,
  z.custom<OfficialApiTemporalProjectionDraft | null>(
    (value) => value === null || (typeof value === "object" && value !== null)
  )
);
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
  canonical_entities: CanonicalEntitiesArraySchema,
  distilled_fact: OptionalTrimmedStringSchema,
  reason: OptionalTrimmedStringSchema,
  temporal_projection: OfficialApiTemporalProjectionSchema,
  preference_profile: OfficialApiPreferenceProfileSchema
}).loose().readonly();

export type { OfficialApiTemporalProjectionDraft } from "./temporal/observed-projection.js";

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
  readonly canonical_entities?: readonly string[];
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
  let envelope: z.infer<typeof OfficialApiSignalsEnvelopeSchema>;
  try {
    envelope = OfficialApiSignalsEnvelopeSchema.parse(parsed);
  } catch {
    throw new Error("signals array missing");
  }

  const drafts: OfficialApiSignalDraft[] = [];
  for (const candidate of envelope.signals.slice(0, OFFICIAL_API_SIGNAL_LIMIT)) {
    const draft = parseOfficialApiSignalEntry(candidate);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  if (envelope.signals.length > 0 && drafts.length === 0) {
    throw new Error("signals array contained no valid entries");
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
    if (drafts.length >= OFFICIAL_API_SIGNAL_LIMIT) {
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
    if (!UnknownRecordSchema.safeParse(candidate).success) {
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

export interface RawOfficialApiSignalElementInspection {
  readonly elements: readonly string[];
  readonly truncated_final_element: boolean;
}

// Walk the `signals` array region of an envelope and return each top-level
// `{...}` element as an independent substring. String-aware (braces inside a
// JSON string literal do not change depth; `\` escapes the next char) so a
// `}` inside `matched_text` never miscounts. A truncated/incomplete FINAL
// element (the array ends before its closing `}`) is dropped — only complete
// balanced elements are returned. Returns [] when no `signals` array region
// is found; the production parsing path treats that as a hard failure.
//
// The inspection preserves the dropped-final-element fact so offline audit
// tooling can account for it without changing production parse behavior.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   countRawEnvelopeSignals
export function inspectRawOfficialApiSignalElements(content: string): RawOfficialApiSignalElementInspection {
  const signalsKeyIndex = findSignalsArrayStart(content);
  if (signalsKeyIndex < 0) {
    return { elements: [], truncated_final_element: false };
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
  return {
    elements,
    truncated_final_element: depth > 0 && elementStart >= 0
  };
}

// Exported so the LongMemEval bench seed path can count the RAW salvageable
// element population (lastTurnRawSignalCount) when the strict envelope parse
// fails — otherwise the dropped corrupt entries would vanish from the
// parse-drop attribution instead of landing in parseDropped.
export function salvageRawSignalElements(content: string): readonly string[] {
  return inspectRawOfficialApiSignalElements(content).elements;
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
export function parseOfficialApiSignalEntry(candidate: unknown): OfficialApiSignalDraft | null {
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
    ...(record.canonical_entities.length === 0 ? {} : { canonical_entities: record.canonical_entities }),
    ...(clampedDistilledFact === null ? {} : { distilled_fact: clampedDistilledFact }),
    ...(clampedReason === null ? {} : { reason: clampedReason }),
    ...(record.temporal_projection === null ? {} : { temporal_projection: record.temporal_projection }),
    ...(record.preference_profile === null ? {} : { preference_profile: record.preference_profile })
  });
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
