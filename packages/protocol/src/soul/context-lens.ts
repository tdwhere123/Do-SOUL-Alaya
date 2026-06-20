import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../shared/schema-primitives.js";
import { EnforcementLevelSchema } from "./claim-form.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ManifestationStateSchema } from "./memory-entry.js";
import { ControlPlaneObjectKind, ScopeClassSchema } from "./object-kind.js";

export const ContextLensEntrySchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    relevance_score: z.number().min(0).max(1),
    manifestation: ManifestationStateSchema,
    scope_class: ScopeClassSchema.optional(),
    source_enforcement: EnforcementLevelSchema.optional()
  })
  .strict()
  .readonly();

export const ContextLensSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.CONTEXT_LENS),
    lens_entries: z.array(ContextLensEntrySchema).readonly(),
    not_a_priority_source: z.literal(true)
  })
  .strict()
  .readonly();

export const ProjectionEntrySchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content_snapshot: NonEmptyStringSchema,
    token_estimate: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const WorkingProjectionSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.WORKING_PROJECTION),
    entries: z.array(ProjectionEntrySchema).readonly(),
    total_token_estimate: NonNegativeIntSchema,
    recall_policy_ref: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

export type ContextLensEntry = z.infer<typeof ContextLensEntrySchema>;
export type ContextLens = z.infer<typeof ContextLensSchema>;
export type ProjectionEntry = z.infer<typeof ProjectionEntrySchema>;
export type WorkingProjection = z.infer<typeof WorkingProjectionSchema>;
