import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  CANONICAL_ENTITIES_MAX,
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedString,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema,
  RatioSchema
} from "../shared/schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { ScopeClassSchema } from "./object-kind.js";

const memoryDimensionValues = [
  "preference",
  "constraint",
  "decision",
  "procedure",
  "fact",
  "hazard",
  "glossary",
  "episode"
] as const;

const sourceKindValues = ["compiler", "user", "seed", "import", "review"] as const;

// invariant: each value names a distinct provenance shape that downstream
// recall/scoring branches on:
//   extracted — Garden compile pulled the fact out of an evidence excerpt
//   explicit  — operator stated it directly (user_seed / soul.resolve confirm)
//   inferred  — LLM produced the fact without a direct user statement
//   derived   — fact is built from other memories via source_memory_refs
//   imported  — bulk import / migration carried the row in
const formationKindValues = ["extracted", "explicit", "inferred", "derived", "imported"] as const;

const decayProfileValues = ["pinned", "stable", "normal", "volatile", "hazard"] as const;

const manifestationStateValues = ["hidden", "hint", "excerpt", "full_eligible"] as const;

const retentionStateValues = ["working", "consolidated", "canon", "archived", "tombstoned"] as const;

const storageTierValues = ["hot", "warm", "cold"] as const;
const timePrecisionValues = ["day", "month", "year", "range", "relative", "unknown"] as const;
const timeSourceValues = ["explicit", "session_timestamp", "relative_resolved"] as const;
const preferencePolarityValues = ["positive", "negative", "neutral"] as const;

// invariant: durable forgetting-disposition marker. A memory is eligible for
// AUTONOMOUS terminal removal ONLY when this is non-null; null is never
// autonomously removed. The precondition is enforced at BOTH the
// autonomous-tombstone step and the physical-delete authority (defense in
// depth). Set only by an audited dormant->tombstoned transition emitting a
// SOUL_MEMORY_STATE_CHANGED EventLog row, never implicitly.
//   compressed     — content preserved in a live synthesis capsule that
//                    references this memory; forget_disposition_ref = capsule id.
//   judged_useless — the mechanical memory importance gate cleared it for drop;
//                    forget_disposition_ref is null.
// see also: packages/core/src/manifestation/importance-gate.ts classifyMemoryImportance.
const forgetDispositionValues = ["compressed", "judged_useless"] as const;

export const MemoryDimension = {
  PREFERENCE: "preference",
  CONSTRAINT: "constraint",
  DECISION: "decision",
  PROCEDURE: "procedure",
  FACT: "fact",
  HAZARD: "hazard",
  GLOSSARY: "glossary",
  EPISODE: "episode"
} as const;

export const SourceKind = {
  COMPILER: "compiler",
  USER: "user",
  SEED: "seed",
  IMPORT: "import",
  REVIEW: "review"
} as const;

export const FormationKind = {
  EXTRACTED: "extracted",
  EXPLICIT: "explicit",
  INFERRED: "inferred",
  DERIVED: "derived",
  IMPORTED: "imported"
} as const;

export const DecayProfile = {
  PINNED: "pinned",
  STABLE: "stable",
  NORMAL: "normal",
  VOLATILE: "volatile",
  HAZARD: "hazard"
} as const;

export const ManifestationState = {
  HIDDEN: "hidden",
  HINT: "hint",
  EXCERPT: "excerpt",
  FULL_ELIGIBLE: "full_eligible"
} as const;

export const RetentionState = {
  WORKING: "working",
  CONSOLIDATED: "consolidated",
  CANON: "canon",
  ARCHIVED: "archived",
  TOMBSTONED: "tombstoned"
} as const;

export const StorageTier = {
  HOT: "hot",
  WARM: "warm",
  COLD: "cold"
} as const;

export const TimePrecision = {
  DAY: "day",
  MONTH: "month",
  YEAR: "year",
  RANGE: "range",
  RELATIVE: "relative",
  UNKNOWN: "unknown"
} as const;

export const TimeSource = {
  EXPLICIT: "explicit",
  SESSION_TIMESTAMP: "session_timestamp",
  RELATIVE_RESOLVED: "relative_resolved"
} as const;

export const PreferencePolarity = {
  POSITIVE: "positive",
  NEGATIVE: "negative",
  NEUTRAL: "neutral"
} as const;

export const ForgetDisposition = {
  COMPRESSED: "compressed",
  JUDGED_USELESS: "judged_useless"
} as const;

// Answer-relevance facet axis: distinct query-intent buckets a memory can carry.
export const FACET_VOCABULARY: readonly string[] = Object.freeze([
  "occupation_work",
  "education",
  "location_place",
  "event_activity",
  "time_date",
  "preference_like",
  "possession_item",
  "relationship_person",
  "health",
  "finance_money",
  "travel",
  "food_dining",
  "hobby_skill",
  "purchase",
  "media_entertainment",
  "life_event",
  "communication_tool"
]);

const FacetTagSchema = z
  .object({
    facet: BoundedLabelSchema,
    value: BoundedString(256).optional()
  })
  .strict();

export const MemoryDimensionSchema = z.enum(memoryDimensionValues);
export const SourceKindSchema = z.enum(sourceKindValues);
export const FormationKindSchema = z.enum(formationKindValues);
export const DecayProfileSchema = z.enum(decayProfileValues);
export const ManifestationStateSchema = z.enum(manifestationStateValues);
export const RetentionStateSchema = z.enum(retentionStateValues);
export const StorageTierSchema = z.enum(storageTierValues);
const TimePrecisionSchema = z.enum(timePrecisionValues);
const TimeSourceSchema = z.enum(timeSourceValues);
const PreferencePolaritySchema = z.enum(preferencePolarityValues);
export const ForgetDispositionSchema = z.enum(forgetDispositionValues);
const MemoryEntryMutableFieldsBaseSchema = z.object({
  // Bound `content` plus each `domain_tags` / `evidence_refs` element so
  // a single MCP call cannot pin the daemon with a 100MB string field.
  // The default-array max keeps the tag list from itself becoming an
  // unbounded amplifier.
  content: BoundedContentSchema.optional(),
  domain_tags: z
    .array(BoundedLabelSchema)
    .max(BOUNDED_DEFAULT_ARRAY_MAX)
    .readonly()
    .optional(),
  evidence_refs: z
    .array(BoundedIdSchema)
    .max(BOUNDED_EVIDENCE_ARRAY_MAX)
    .readonly()
    .optional(),
  storage_tier: StorageTierSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  retention_state: RetentionStateSchema.optional()
}).strict();

const MemoryEntryProjectionMutableFieldsSchema = z.object({
  projection_schema_version: z.number().int().min(1).max(1).nullable().optional(),
  event_time_start: IsoDatetimeStringSchema.nullable().optional(),
  event_time_end: IsoDatetimeStringSchema.nullable().optional(),
  valid_from: IsoDatetimeStringSchema.nullable().optional(),
  valid_to: IsoDatetimeStringSchema.nullable().optional(),
  time_precision: TimePrecisionSchema.nullable().optional(),
  time_source: TimeSourceSchema.nullable().optional(),
  preference_subject: BoundedLabelSchema.nullable().optional(),
  preference_predicate: BoundedLabelSchema.nullable().optional(),
  preference_object: BoundedLabelSchema.nullable().optional(),
  preference_category: BoundedLabelSchema.nullable().optional(),
  preference_polarity: PreferencePolaritySchema.nullable().optional(),
  facet_tags: z.array(FacetTagSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().nullable().optional(),
  canonical_entities: z.array(BoundedLabelSchema).max(CANONICAL_ENTITIES_MAX).readonly().nullable().optional()
}).strict();

export const MemoryEntryMutableFieldsSchema = MemoryEntryMutableFieldsBaseSchema
  .extend(MemoryEntryProjectionMutableFieldsSchema.shape)
  .readonly();

/**
 * Strict variant for the public MCP `soul.propose_memory_update`
 * surface: rejects unknown keys at parse time so attached agents
 * cannot smuggle silent fields into proposals.
 */
export const PublicMemoryEntryMutableFieldsSchema =
  MemoryEntryMutableFieldsBaseSchema.strict().readonly();


export const MemoryEntryRepoUpdateFieldsSchema = MemoryEntryMutableFieldsBaseSchema.extend({
  ...MemoryEntryProjectionMutableFieldsSchema.shape,
  updated_at: IsoDatetimeStringSchema
}).strict().readonly();
export const MemoryEntrySchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal("memory_entry"),
    dimension: MemoryDimensionSchema,
    source_kind: SourceKindSchema,
    formation_kind: FormationKindSchema,
    scope_class: ScopeClassSchema,
    content: BoundedContentSchema,
    domain_tags: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    evidence_refs: z.array(BoundedIdSchema).max(BOUNDED_EVIDENCE_ARRAY_MAX).readonly(),
    workspace_id: BoundedIdSchema,
    run_id: BoundedIdSchema,
    surface_id: BoundedIdSchema.nullable(),
    storage_tier: StorageTierSchema,
    activation_score: RatioSchema.nullable(),
    retention_score: RatioSchema.nullable(),
    manifestation_state: ManifestationStateSchema.nullable(),
    retention_state: RetentionStateSchema.nullable(),
    decay_profile: DecayProfileSchema.nullable(),
    confidence: RatioSchema.nullable(),
    last_used_at: IsoDatetimeStringSchema.nullable(),
    last_hit_at: IsoDatetimeStringSchema.nullable(),
    reinforcement_count: NonNegativeIntSchema.nullable(),
    contradiction_count: NonNegativeIntSchema.nullable(),
    superseded_by: BoundedIdSchema.nullable(),
    projection_schema_version: z.number().int().min(1).max(1).nullable().optional(),
    event_time_start: IsoDatetimeStringSchema.nullable().optional(),
    event_time_end: IsoDatetimeStringSchema.nullable().optional(),
    valid_from: IsoDatetimeStringSchema.nullable().optional(),
    valid_to: IsoDatetimeStringSchema.nullable().optional(),
    time_precision: TimePrecisionSchema.nullable().optional(),
    time_source: TimeSourceSchema.nullable().optional(),
    preference_subject: BoundedLabelSchema.nullable().optional(),
    preference_predicate: BoundedLabelSchema.nullable().optional(),
    preference_object: BoundedLabelSchema.nullable().optional(),
    preference_category: BoundedLabelSchema.nullable().optional(),
    preference_polarity: PreferencePolaritySchema.nullable().optional(),
    facet_tags: z.array(FacetTagSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().nullable().optional(),
    // Normalized lowercase canonical entities/subjects this memory is about (entity-graph recall fuel).
    canonical_entities: z.array(BoundedLabelSchema).max(CANONICAL_ENTITIES_MAX).readonly().nullable().optional(),
    // invariant: optional on the wire (legacy rows + most constructors omit it),
    // but the storage layer always materializes it as null|value. Safety treats
    // undefined and null identically as "no disposition" — non-null/defined is
    // the hard precondition for autonomous terminal removal.
    forget_disposition: ForgetDispositionSchema.nullable().optional(),
    forget_disposition_ref: BoundedIdSchema.nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const disposition = value.forget_disposition ?? null;
    const dispositionRef = value.forget_disposition_ref ?? null;
    if (disposition === "compressed" && dispositionRef === null) {
      context.addIssue({
        code: "custom",
        path: ["forget_disposition_ref"],
        message: "compressed forget_disposition requires forget_disposition_ref."
      });
    }
    if (disposition === "judged_useless" && dispositionRef !== null) {
      context.addIssue({
        code: "custom",
        path: ["forget_disposition_ref"],
        message: "judged_useless forget_disposition must not carry forget_disposition_ref."
      });
    }
    if (disposition === null && dispositionRef !== null) {
      context.addIssue({
        code: "custom",
        path: ["forget_disposition_ref"],
        message: "forget_disposition_ref requires forget_disposition."
      });
    }
  })
  .readonly();

export type MemoryDimension = z.infer<typeof MemoryDimensionSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type FormationKind = z.infer<typeof FormationKindSchema>;
export type DecayProfile = z.infer<typeof DecayProfileSchema>;
export type ManifestationState = z.infer<typeof ManifestationStateSchema>;
export type RetentionState = z.infer<typeof RetentionStateSchema>;
export type StorageTier = z.infer<typeof StorageTierSchema>;
export type TimePrecision = z.infer<typeof TimePrecisionSchema>;
export type TimeSource = z.infer<typeof TimeSourceSchema>;
export type PreferencePolarity = z.infer<typeof PreferencePolaritySchema>;
export type ForgetDisposition = z.infer<typeof ForgetDispositionSchema>;
export type MemoryEntryMutableFields = z.infer<typeof MemoryEntryMutableFieldsSchema>;
export type MemoryEntryRepoUpdateFields = z.infer<typeof MemoryEntryRepoUpdateFieldsSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
