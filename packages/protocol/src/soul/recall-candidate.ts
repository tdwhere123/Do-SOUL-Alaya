import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  BoundedReasonSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { ManifestationStateSchema, MemoryDimensionSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";
import { ActivationWeightsSchema } from "./recall-policy.js";

const recallOriginPlaneValues = ["workspace_local", "global"] as const;

export const RecallOriginPlaneSchema = z.enum(recallOriginPlaneValues);

export const RecallScoreFactorsSchema = z
  .object({
    activation: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    graph_support: z.number().min(0).max(1).optional(),
    path_plasticity: z.number().min(0).max(1).optional(),
    budget_penalty: z.number().min(0).max(1).optional(),
    embedding_similarity: z.number().min(0).max(1).optional(),
    conflict_penalty: z.number().min(0).max(1).optional(),
    // invariant: degradation factor in [0, 0.25] applied by recall scoring
    // when MemoryEntry.contradiction_count > 0 (0.05 per contradiction,
    // capped at 5 contradictions). Producer: ConflictDetectionService.
    contradiction_penalty: z.number().min(0).max(1).optional(),
    // invariant: producer-side epistemic certainty in [0, 1] copied from
    // MemoryEntry.confidence and applied additively (outside the
    // sum-to-1 activation_weights) so propose/accept updates reach
    // recall ordering without going through retention/activation decay.
    confidence: z.number().min(0).max(1).optional(),
    resolved_activation_weights: ActivationWeightsSchema.optional()
  })
  .strict()
  .readonly();

export const RecallBudgetStateSchema = z
  .object({
    token_estimate: NonNegativeIntSchema,
    max_entries: NonNegativeIntSchema,
    max_total_tokens: NonNegativeIntSchema,
    remaining_entries: NonNegativeIntSchema.nullable(),
    remaining_tokens: NonNegativeIntSchema.nullable(),
    within_budget: z.boolean()
  })
  .strict()
  .readonly();

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
    is_advisory: z.boolean().optional(),
    selection_reason: BoundedReasonSchema.optional(),
    source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    score_factors: RecallScoreFactorsSchema.optional(),
    budget_state: RecallBudgetStateSchema.optional()
  })
  .strict()
  .readonly();

export type RecallOriginPlane = z.infer<typeof RecallOriginPlaneSchema>;
export type RecallScoreFactors = z.infer<typeof RecallScoreFactorsSchema>;
export type RecallBudgetState = z.infer<typeof RecallBudgetStateSchema>;
export type RecallCandidate = z.infer<typeof RecallCandidateSchema>;
