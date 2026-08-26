import { z } from "zod";
import {
  AssociativeFactFrameSchema,
  OpenSemanticFactorGraphProposalSchema,
  type AssociativeFactFrame,
  type CandidateMemorySignal,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";
import { DISTILLED_FACT_MAX_CHARS } from "./materialization-router.js";
import {
  inspectOfficialApiTemporalProjection,
  parseOfficialApiTemporalProjection,
  type OfficialApiTemporalProjectionAudit,
  type OfficialApiTemporalProjectionDraft
} from "./temporal/observed-projection.js";
import {
  OfficialApiSourceLocatorSchema,
  type OfficialApiSourceLocator
} from "./grounding/source-locator.js";
import {
  inspectOfficialApiSemanticFactorGraphProjection,
  type OfficialApiSemanticFactorGraphProjectionAudit
} from "./official-api/semantic-factor-projection.js";
import { salvageRawSignalElements } from "./official-api/raw-signal-envelope.js";
import {
  projectOfficialApiObjectKind,
  type OfficialApiObjectKindProjection
} from "./official-api/object-kind-contract.js";
import {
  readOfficialApiKindProjectionDraft,
  type OfficialApiKindProjectionDraft
} from "./official-api/kind-projection-draft.js";

export const OFFICIAL_API_SIGNAL_LIMIT = 64;
export {
  OPEN_SEMANTIC_OBSERVATION_OBJECT_KIND
} from "./official-api/object-kind-contract.js";
// Raw cache identity and parser projection identity evolve independently.
export const OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION = "official-api-signal-parser-v10";
const MAX_OFFICIAL_API_MATCHED_TEXT_CHARS = 4_000;
const MAX_OFFICIAL_API_REASON_CHARS = 400;
const CANONICAL_CONFIDENCE_PATTERN = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u;
const UnknownRecordSchema = z.record(z.string(), z.unknown()).readonly();
const OfficialApiSignalsEnvelopeSchema = z.object({
  signals: z.array(z.unknown()).readonly()
}).loose().readonly();

const RequiredTrimmedStringSchema = z.preprocess(normalizeStringValue, z.string().min(1));
const OptionalTrimmedStringSchema = z
  .preprocess(normalizeStringValue, z.string().min(1).nullable())
  .transform((value) => value ?? null);
const OfficialApiConfidenceSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return CANONICAL_CONFIDENCE_PATTERN.test(normalized)
    ? Number(normalized)
    : value;
}, z.number().min(0).max(1));
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
const OptionalAssociativeFactFrameSchema = z.preprocess((value) => {
  const parsed = AssociativeFactFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, AssociativeFactFrameSchema.optional());
const OptionalOpenSemanticFactorGraphSchema =
  OpenSemanticFactorGraphProposalSchema.optional();
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
const OfficialApiSignalEntrySharedShape = {
  confidence: OfficialApiConfidenceSchema,
  matched_text: RequiredTrimmedStringSchema,
  evidence_refs: StringArraySchema,
  source_memory_refs: StringArraySchema,
  canonical_entities: CanonicalEntitiesArraySchema,
  distilled_fact: OptionalTrimmedStringSchema,
  reason: OptionalTrimmedStringSchema,
  // A declared locator is strict; absence means the whole source assertion is grounded.
  source_locator: OfficialApiSourceLocatorSchema.optional(),
  temporal_projection: OfficialApiTemporalProjectionSchema,
  preference_profile: OfficialApiPreferenceProfileSchema,
  fact_frame: OptionalAssociativeFactFrameSchema,
  semantic_factor_graph: OptionalOpenSemanticFactorGraphSchema
} as const;
const OpenOfficialApiSignalEntrySchema = z.object({
  signal_kind: RequiredTrimmedStringSchema.optional(),
  object_kind: RequiredTrimmedStringSchema.optional(),
  ...OfficialApiSignalEntrySharedShape
}).loose().readonly();

export type { OfficialApiTemporalProjectionDraft } from "./temporal/observed-projection.js";
export type {
  OfficialApiSemanticFactorGraphFields,
  OfficialApiSemanticFactorGraphProjectionAudit,
  OfficialApiSemanticFactorGraphProjectionReason
} from "./official-api/semantic-factor-projection.js";
export {
  inspectOfficialApiSemanticFactorGraphProjection,
  parseOfficialApiSemanticFactorGraphProjectionAudit,
  projectOfficialApiSemanticFactorGraph
} from "./official-api/semantic-factor-projection.js";
export {
  inspectRawOfficialApiSignalElements,
  salvageRawSignalElements
} from "./official-api/raw-signal-envelope.js";
export type {
  RawOfficialApiSignalElementInspection
} from "./official-api/raw-signal-envelope.js";

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
  readonly object_kind_projection?: OfficialApiObjectKindProjection;
  readonly confidence: number;
  readonly matched_text: string;
  readonly evidence_refs: readonly string[];
  readonly source_memory_refs: readonly string[];
  readonly canonical_entities?: readonly string[];
  readonly distilled_fact?: string;
  readonly reason?: string;
  readonly source_locator?: OfficialApiSourceLocator;
  readonly temporal_projection?: OfficialApiTemporalProjectionDraft;
  readonly temporal_projection_audit?: OfficialApiTemporalProjectionAudit;
  readonly preference_profile?: OfficialApiPreferenceProfileDraft;
  readonly fact_frame?: AssociativeFactFrame;
  readonly semantic_factor_graph?: OpenSemanticFactorGraphProposal;
  readonly semantic_factor_graph_projection?:
    OfficialApiSemanticFactorGraphProjectionAudit;
  readonly kind_projection?: OfficialApiKindProjectionDraft;
}

export interface OfficialApiSignalParseOptions {
  readonly requireSemanticFactorGraph?: boolean;
}

type OfficialApiSignalEntryRejection =
  | "signal_entry_invalid"
  | "fact_frame_required"
  | "semantic_factor_graph_required";
type OfficialApiSignalEntryInspection = Readonly<
  | {
      readonly draft: OfficialApiSignalDraft;
      readonly rejection: null;
    }
  | {
      readonly draft: null;
      readonly rejection: OfficialApiSignalEntryRejection;
    }
>;

// Exported so the LongMemEval bench seed path can drive its ingestion
// through this exact production parse instead of a divergent bench-only
// copy.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
export function parseOfficialApiSignals(
  content: string,
  options: OfficialApiSignalParseOptions = {}
): readonly OfficialApiSignalDraft[] {
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
    return salvageOfficialApiSignals(content, options);
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
  const rejections: OfficialApiSignalEntryRejection[] = [];
  for (const candidate of envelope.signals.slice(0, OFFICIAL_API_SIGNAL_LIMIT)) {
    const inspected = inspectOfficialApiSignalEntry(candidate, options);
    if (inspected.draft === null) rejections.push(inspected.rejection);
    else drafts.push(inspected.draft);
  }
  if (envelope.signals.length > 0 && drafts.length === 0) {
    throw noValidOpenEntriesError(rejections);
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
function salvageOfficialApiSignals(
  content: string,
  options: OfficialApiSignalParseOptions
): readonly OfficialApiSignalDraft[] {
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
    const draft = parseOfficialApiSignalEntry(candidate, options);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  if (drafts.length === 0) {
    throw new Error("signals envelope unparseable and no element recoverable");
  }
  return Object.freeze(drafts);
}

// Parse one entry of the official-API {"signals":[...]} envelope. Returns
// null — instead of throwing — when the entry is malformed (hallucinated
// signal_kind, missing object_kind / matched_text / confidence, or a
// non-object element), so one bad fact is dropped while the rest survive.
export function parseOfficialApiSignalEntry(
  candidate: unknown,
  options: OfficialApiSignalParseOptions = {}
): OfficialApiSignalDraft | null {
  return inspectOfficialApiSignalEntry(candidate, options).draft;
}

function inspectOfficialApiSignalEntry(
  candidate: unknown,
  options: OfficialApiSignalParseOptions
): OfficialApiSignalEntryInspection {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { draft: null, rejection: "signal_entry_invalid" };
  }
  const semanticProjection = inspectOfficialApiSemanticFactorGraphProjection(
    (candidate as Record<string, unknown>).semantic_factor_graph
  );
  if (options.requireSemanticFactorGraph === true && semanticProjection.graph === undefined) {
    return { draft: null, rejection: "semantic_factor_graph_required" };
  }
  if (options.requireSemanticFactorGraph === true &&
      !AssociativeFactFrameSchema.safeParse(
        (candidate as Record<string, unknown>).fact_frame
      ).success) {
    return { draft: null, rejection: "fact_frame_required" };
  }
  const temporalProjection = inspectOfficialApiTemporalProjection(
    (candidate as Record<string, unknown>).temporal_projection
  );
  const parsed = OpenOfficialApiSignalEntrySchema.safeParse({
    ...(candidate as Record<string, unknown>),
    temporal_projection: temporalProjection.projection,
    semantic_factor_graph: semanticProjection.graph
  });
  if (!parsed.success) {
    return { draft: null, rejection: "signal_entry_invalid" };
  }
  const objectKindProjection = projectOfficialApiObjectKind(parsed.data.object_kind ?? undefined);
  return {
    draft: buildOfficialApiSignalDraft(Object.freeze({
      ...parsed.data,
      signal_kind: objectKindProjection.signalKind,
      object_kind: objectKindProjection.objectKind
    }), semanticProjection.audit, temporalProjection.audit, objectKindProjection.audit,
    readOfficialApiKindProjectionDraft(
      (candidate as Record<string, unknown>).kind_projection
    )),
    rejection: null
  };
}

function buildOfficialApiSignalDraft(
  record: z.infer<typeof OpenOfficialApiSignalEntrySchema> & {
    readonly signal_kind: CandidateMemorySignal["signal_kind"];
    readonly object_kind: string;
  },
  semanticFactorGraphProjection: OfficialApiSemanticFactorGraphProjectionAudit | undefined,
  temporalProjectionAudit: OfficialApiTemporalProjectionAudit,
  objectKindProjection: OfficialApiObjectKindProjection | undefined,
  kindProjection: OfficialApiKindProjectionDraft | undefined
): OfficialApiSignalDraft {
  const clampedMatchedText = record.matched_text.slice(0, MAX_OFFICIAL_API_MATCHED_TEXT_CHARS);
  // Absence delegates to the materialization rule distiller; matched_text is not a substitute.
  const clampedDistilledFact =
    record.distilled_fact === null ? null : record.distilled_fact.slice(0, DISTILLED_FACT_MAX_CHARS);
  const clampedReason = record.reason === null ? null : record.reason.slice(0, MAX_OFFICIAL_API_REASON_CHARS);
  return Object.freeze({
    signal_kind: record.signal_kind,
    object_kind: record.object_kind,
    ...(objectKindProjection === undefined ? {} : {
      object_kind_projection: objectKindProjection
    }),
    confidence: record.confidence,
    matched_text: clampedMatchedText,
    evidence_refs: record.evidence_refs,
    source_memory_refs: record.source_memory_refs,
    ...(record.canonical_entities.length === 0 ? {} : { canonical_entities: record.canonical_entities }),
    ...(clampedDistilledFact === null ? {} : { distilled_fact: clampedDistilledFact }),
    ...(clampedReason === null ? {} : { reason: clampedReason }),
    ...(record.source_locator === undefined ? {} : { source_locator: record.source_locator }),
    ...(record.temporal_projection === null ? {} : { temporal_projection: record.temporal_projection }),
    temporal_projection_audit: temporalProjectionAudit,
    ...(record.preference_profile === null ? {} : { preference_profile: record.preference_profile }),
    ...(record.fact_frame === undefined ? {} : { fact_frame: record.fact_frame }),
    ...(record.semantic_factor_graph === undefined
      ? {}
      : { semantic_factor_graph: record.semantic_factor_graph }),
    ...(semanticFactorGraphProjection === undefined
      ? {}
      : { semantic_factor_graph_projection: semanticFactorGraphProjection }),
    ...(kindProjection === undefined ? {} : { kind_projection: kindProjection })
  });
}

function noValidOpenEntriesError(
  rejections: readonly OfficialApiSignalEntryRejection[]
): Error {
  const counts = new Map<OfficialApiSignalEntryRejection, number>();
  for (const rejection of rejections) {
    counts.set(rejection, (counts.get(rejection) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  return new Error(
    "signals array contained no valid open semantic factor entries " +
      `(rejections=${summary})`
  );
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
