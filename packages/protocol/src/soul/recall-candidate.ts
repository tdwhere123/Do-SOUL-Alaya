import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { ManifestationStateSchema, MemoryDimensionSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";

const recallOriginPlaneValues = ["workspace_local", "global"] as const;

export const RecallOriginPlaneSchema = z.enum(recallOriginPlaneValues);

export const RecallCandidateSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: z.literal("memory_entry"),
    activation_score: z.number().min(0).max(1),
    relevance_score: z.number().min(0).max(1),
    content_preview: NonEmptyStringSchema,
    token_estimate: NonNegativeIntSchema,
    manifestation: ManifestationStateSchema,
    dimension: MemoryDimensionSchema,
    scope_class: ScopeClassSchema,
    origin_plane: RecallOriginPlaneSchema.default("workspace_local"),
    is_advisory: z.boolean().optional()
  })
  .strict()
  .readonly();

export type RecallOriginPlane = z.infer<typeof RecallOriginPlaneSchema>;
export type RecallCandidate = z.infer<typeof RecallCandidateSchema>;
