import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { EvidenceHealthStateSchema } from "./status-model.js";

const evidenceKindValues = [
  "user_statement",
  "code_observation",
  "tool_output",
  "conversation_excerpt",
  "file_content",
  "external_reference",
  "inferred"
] as const;

export const EvidenceKind = {
  USER_STATEMENT: "user_statement",
  CODE_OBSERVATION: "code_observation",
  TOOL_OUTPUT: "tool_output",
  CONVERSATION_EXCERPT: "conversation_excerpt",
  FILE_CONTENT: "file_content",
  EXTERNAL_REFERENCE: "external_reference",
  INFERRED: "inferred"
} as const;

export const EvidenceKindSchema = z.enum(evidenceKindValues);

export const SemanticAnchorSchema = z
  .object({
    topic: NonEmptyStringSchema,
    keywords: z.array(NonEmptyStringSchema),
    summary: NonEmptyStringSchema
  })
  .readonly();

export const EventAnchorSchema = z
  .object({
    event_type: NonEmptyStringSchema,
    event_id: NonEmptyStringSchema.nullable(),
    occurred_at: IsoDatetimeStringSchema
  })
  .readonly();

export const LineRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  })
  .refine((value) => value.start <= value.end, {
    message: "line_range.start must be less than or equal to line_range.end"
  })
  .readonly();

export const PhysicalAnchorSchema = z
  .object({
    file_path: NonEmptyStringSchema.nullable(),
    line_range: LineRangeSchema.nullable(),
    symbol_name: NonEmptyStringSchema.nullable(),
    artifact_ref: NonEmptyStringSchema.nullable()
  })
  .readonly();

// invariant: evidence anchors are split by meaning. Semantic anchors carry
// the claim/topic shape, event anchors carry EventLog coordinates, and
// physical anchors carry file/symbol/artifact coordinates.
export const EvidenceCapsuleSchema = PersistentObjectEnvelopeSchema.unwrap().extend({
  object_kind: z.literal("evidence_capsule"),
  evidence_kind: EvidenceKindSchema,
  semantic_anchor: SemanticAnchorSchema,
  event_anchor: EventAnchorSchema.nullable(),
  physical_anchor: PhysicalAnchorSchema.nullable(),
  evidence_health_state: EvidenceHealthStateSchema,
  gist: NonEmptyStringSchema,
  excerpt: NonEmptyStringSchema.nullable(),
  source_hash: NonEmptyStringSchema.nullable(),
  run_id: NonEmptyStringSchema,
  workspace_id: NonEmptyStringSchema,
  surface_id: NonEmptyStringSchema.nullable()
}).readonly();

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type SemanticAnchor = z.infer<typeof SemanticAnchorSchema>;
export type EventAnchor = z.infer<typeof EventAnchorSchema>;
export type LineRange = z.infer<typeof LineRangeSchema>;
export type PhysicalAnchor = z.infer<typeof PhysicalAnchorSchema>;
export type EvidenceCapsule = z.infer<typeof EvidenceCapsuleSchema>;
