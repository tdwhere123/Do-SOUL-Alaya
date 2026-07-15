import { z } from "zod";
import {
  BoundedLabelSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { MemoryDimensionSchema } from "./memory-entry.js";
import { ControlPlaneObjectKind, ScopeClassSchema } from "./object-kind.js";

export const DeterministicMatchConfigSchema = z
  .object({
    scope_filter: z.array(ScopeClassSchema).readonly().nullable(),
    dimension_filter: z.array(MemoryDimensionSchema).readonly().nullable(),
    domain_tag_filter: z.array(NonEmptyStringSchema).readonly().nullable()
  })
  .strict()
  .readonly();

export const PrecomputedRankConfigSchema = z
  .object({
    max_candidates: NonNegativeIntSchema,
    min_activation_score: z.number().min(0).max(1).nullable()
  })
  .strict()
  .readonly();

export const SemanticSupplementConfigSchema = z
  .object({
    enabled: z.boolean(),
    max_supplement: NonNegativeIntSchema,
    embedding_enabled: z.boolean().optional(),
    // Pure-semantic coarse-injection cap (pool-external, zero-lexical-overlap
    // neighbors the embedding stream injects) and the cosine floor gating them.
    // Distinct from max_supplement (the coarse pool budget); omitted => recall
    // service defaults.
    injection_cap: NonNegativeIntSchema.optional(),
    injection_similarity_floor: z.number().min(0).max(1).optional()
  })
  .strict()
  .readonly();

export const CoarseFilterConfigSchema = z
  .object({
    deterministic_match: DeterministicMatchConfigSchema,
    precomputed_rank: PrecomputedRankConfigSchema,
    semantic_supplement: SemanticSupplementConfigSchema
  })
  .strict()
  .readonly();

export const RecallBudgetsSchema = z
  .object({
    max_total_tokens: NonNegativeIntSchema,
    max_entries: NonNegativeIntSchema,
    per_dimension_limits: z.record(BoundedLabelSchema, NonNegativeIntSchema).readonly().nullable()
  })
  .strict()
  .readonly();

export const FineAssessmentConfigSchema = z
  .object({
    budgets: RecallBudgetsSchema,
    max_candidates: NonNegativeIntSchema.optional(),
    conflict_awareness: z.boolean()
  })
  .strict()
  .readonly();

const ActivationWeightsShape = {
  scope_match: z.number().min(0).max(1),
  domain_match: z.number().min(0).max(1),
  retention: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  graph_support: z.number().min(0).max(1),
  budget_penalty: z.number().min(0).max(1),
  conflict_penalty: z.number().min(0).max(1)
} as const;

export const ActivationWeightsSchema = z.object(ActivationWeightsShape).strict().readonly();

export const ActivationWeightsPatchSchema = z.object(ActivationWeightsShape).partial().strict().readonly();

export const RecallAdditiveScoringWeightsSchema = z
  .object({
    NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: z.number().finite().nonnegative().optional(),
    CONFIDENCE_DIRECT_WEIGHT: z.number().finite().nonnegative().optional(),
    PATH_PLASTICITY_WEIGHT: z.number().finite().nonnegative().optional()
  })
  .strict()
  .readonly();

export const RecallScoringWeightOverridesSchema = z
  .object({
    additive: RecallAdditiveScoringWeightsSchema.optional(),
    fusion_weights: z.record(NonEmptyStringSchema, z.number().finite().nonnegative()).optional()
  })
  .strict()
  .readonly();

export const RecallPolicySchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.RECALL_POLICY),
    coarse_filter: CoarseFilterConfigSchema,
    fine_assessment: FineAssessmentConfigSchema,
    domain_weight_overrides: z.record(NonEmptyStringSchema, ActivationWeightsPatchSchema).optional(),
    scoring_weight_overrides: RecallScoringWeightOverridesSchema.optional()
  })
  .strict()
  .readonly();

export type DeterministicMatchConfig = z.infer<typeof DeterministicMatchConfigSchema>;
export type PrecomputedRankConfig = z.infer<typeof PrecomputedRankConfigSchema>;
export type SemanticSupplementConfig = z.infer<typeof SemanticSupplementConfigSchema>;
export type CoarseFilterConfig = z.infer<typeof CoarseFilterConfigSchema>;
export type RecallBudgets = z.infer<typeof RecallBudgetsSchema>;
export type FineAssessmentConfig = z.infer<typeof FineAssessmentConfigSchema>;
export type ActivationWeights = z.infer<typeof ActivationWeightsSchema>;
export type ActivationWeightsPatch = z.infer<typeof ActivationWeightsPatchSchema>;
export type RecallAdditiveScoringWeights = z.infer<typeof RecallAdditiveScoringWeightsSchema>;
export type RecallScoringWeightOverrides = z.infer<typeof RecallScoringWeightOverridesSchema>;
export type RecallPolicy = z.infer<typeof RecallPolicySchema>;
