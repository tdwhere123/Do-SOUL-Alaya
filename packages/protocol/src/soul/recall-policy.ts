import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { MemoryDimensionSchema } from "./memory-entry.js";
import { ControlPlaneObjectKind, ScopeClassSchema } from "./object-kind.js";

export const DeterministicMatchConfigSchema = z
  .object({
    scope_filter: z.array(ScopeClassSchema).readonly().nullable(),
    dimension_filter: z.array(MemoryDimensionSchema).readonly().nullable(),
    domain_tag_filter: z.array(NonEmptyStringSchema).readonly().nullable()
  })
  .readonly();

export const PrecomputedRankConfigSchema = z
  .object({
    max_candidates: NonNegativeIntSchema,
    min_activation_score: z.number().min(0).max(1).nullable()
  })
  .readonly();

export const SemanticSupplementConfigSchema = z
  .object({
    enabled: z.boolean(),
    max_supplement: NonNegativeIntSchema,
    embedding_enabled: z.boolean().optional()
  })
  .readonly();

export const CoarseFilterConfigSchema = z
  .object({
    deterministic_match: DeterministicMatchConfigSchema,
    precomputed_rank: PrecomputedRankConfigSchema,
    semantic_supplement: SemanticSupplementConfigSchema
  })
  .readonly();

export const RecallBudgetsSchema = z
  .object({
    max_total_tokens: NonNegativeIntSchema,
    max_entries: NonNegativeIntSchema,
    per_dimension_limits: z.record(NonNegativeIntSchema).readonly().nullable()
  })
  .readonly();

export const FineAssessmentConfigSchema = z
  .object({
    budgets: RecallBudgetsSchema,
    conflict_awareness: z.boolean()
  })
  .readonly();

export const RecallPolicySchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.RECALL_POLICY),
    coarse_filter: CoarseFilterConfigSchema,
    fine_assessment: FineAssessmentConfigSchema
  })
  .readonly();

export type DeterministicMatchConfig = z.infer<typeof DeterministicMatchConfigSchema>;
export type PrecomputedRankConfig = z.infer<typeof PrecomputedRankConfigSchema>;
export type SemanticSupplementConfig = z.infer<typeof SemanticSupplementConfigSchema>;
export type CoarseFilterConfig = z.infer<typeof CoarseFilterConfigSchema>;
export type RecallBudgets = z.infer<typeof RecallBudgetsSchema>;
export type FineAssessmentConfig = z.infer<typeof FineAssessmentConfigSchema>;
export type RecallPolicy = z.infer<typeof RecallPolicySchema>;
