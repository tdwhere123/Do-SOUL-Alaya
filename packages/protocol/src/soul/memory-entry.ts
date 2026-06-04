import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedLabelSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
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
// see also: packages/core/src/importance-gate.ts classifyMemoryImportance.
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

export const ForgetDisposition = {
  COMPRESSED: "compressed",
  JUDGED_USELESS: "judged_useless"
} as const;

export const MemoryDimensionSchema = z.enum(memoryDimensionValues);
export const SourceKindSchema = z.enum(sourceKindValues);
export const FormationKindSchema = z.enum(formationKindValues);
export const DecayProfileSchema = z.enum(decayProfileValues);
export const ManifestationStateSchema = z.enum(manifestationStateValues);
export const RetentionStateSchema = z.enum(retentionStateValues);
export const StorageTierSchema = z.enum(storageTierValues);
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
});

export const MemoryEntryMutableFieldsSchema = MemoryEntryMutableFieldsBaseSchema.readonly();

/**
 * Strict variant for the public MCP `soul.propose_memory_update`
 * surface: rejects unknown keys at parse time so attached agents
 * cannot smuggle silent fields into proposals.
 */
export const PublicMemoryEntryMutableFieldsSchema =
  MemoryEntryMutableFieldsBaseSchema.strict().readonly();


export const MemoryEntryRepoUpdateFieldsSchema = MemoryEntryMutableFieldsBaseSchema.extend({
  updated_at: IsoDatetimeStringSchema
}).readonly();
export const MemoryEntrySchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal("memory_entry"),
    dimension: MemoryDimensionSchema,
    source_kind: SourceKindSchema,
    formation_kind: FormationKindSchema,
    scope_class: ScopeClassSchema,
    content: NonEmptyStringSchema,
    domain_tags: z.array(NonEmptyStringSchema).readonly(),
    evidence_refs: z.array(NonEmptyStringSchema).readonly(),
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    surface_id: NonEmptyStringSchema.nullable(),
    storage_tier: StorageTierSchema,
    activation_score: z.number().min(0).max(1).nullable(),
    retention_score: z.number().min(0).max(1).nullable(),
    manifestation_state: ManifestationStateSchema.nullable(),
    retention_state: RetentionStateSchema.nullable(),
    decay_profile: DecayProfileSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    last_used_at: IsoDatetimeStringSchema.nullable(),
    last_hit_at: IsoDatetimeStringSchema.nullable(),
    reinforcement_count: NonNegativeIntSchema.nullable(),
    contradiction_count: NonNegativeIntSchema.nullable(),
    superseded_by: NonEmptyStringSchema.nullable(),
    // invariant: optional on the wire (legacy rows + most constructors omit it),
    // but the storage layer always materializes it as null|value. Safety treats
    // undefined and null identically as "no disposition" — non-null/defined is
    // the hard precondition for autonomous terminal removal.
    forget_disposition: ForgetDispositionSchema.nullable().optional(),
    forget_disposition_ref: NonEmptyStringSchema.nullable().optional()
  })
  .readonly();

export type MemoryDimension = z.infer<typeof MemoryDimensionSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type FormationKind = z.infer<typeof FormationKindSchema>;
export type DecayProfile = z.infer<typeof DecayProfileSchema>;
export type ManifestationState = z.infer<typeof ManifestationStateSchema>;
export type RetentionState = z.infer<typeof RetentionStateSchema>;
export type StorageTier = z.infer<typeof StorageTierSchema>;
export type ForgetDisposition = z.infer<typeof ForgetDispositionSchema>;
export type MemoryEntryMutableFields = z.infer<typeof MemoryEntryMutableFieldsSchema>;
export type MemoryEntryRepoUpdateFields = z.infer<typeof MemoryEntryRepoUpdateFieldsSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
