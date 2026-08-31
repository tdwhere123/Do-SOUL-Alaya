import { z } from "zod";
import { CaptureExecutionSchema } from "../recall/selection/capture/capture-execution.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  BoundedQuerySchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { MemoryDimensionSchema } from "../memory/memory-entry.js";
import { ScopeClassSchema } from "../memory/object-kind.js";
import { ClaimLifecycleStateSchema } from "../memory/claim-form.js";
import { PathGovernanceClassSchema } from "../relations/path-relation.js";
import {
  RecallBudgetStateSchema,
  RecallScoreFactorsSchema
} from "../recall/recall-candidate.js";
import { StagedWarningArraySchema } from "../governance/staged-warning.js";

export const SoulRecallStrategyMixSchema = z
  .object({
    deterministic_match: z.boolean(),
    precomputed_rank: z.boolean(),
    semantic_supplement: z.boolean(),
    graph_support: z.boolean(),
    path_plasticity: z.boolean(),
    global_recall: z.boolean()
  })
  .strict()
  .readonly();

export const SoulMemorySearchDegradationReasonSchema = z.enum([
  "recall_explainability_partial",
  "warm_cascade_engaged",
  "cold_cascade_engaged",
  // Embedding was intended; leave MCP degradation_reason non-null for these failures.
  "provider_missing",
  "provider_unavailable",
  "provider_failed",
  "no_stored_vectors"
]);

export const MemorySearchResultSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    // Not ranking authority. Delivery order is the parent `results` array.
    // Do not re-sort on this field or score_factors.relevance.
    relevance_score: z.number().min(0).max(1),
    content_preview: NonEmptyStringSchema,
    evidence_pointers: z.array(NonEmptyStringSchema).readonly(),
    // Diagnostic-only prose. Agents must not branch on its wording or use it
    // as a ranking key. ranking_authority on the parent packet names the owner.
    selection_reason: BoundedReasonSchema,
    source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    // Public numeric explainability API for soul.recall consumers.
    score_factors: RecallScoreFactorsSchema,
    budget_state: RecallBudgetStateSchema,
    pending_incomplete: z.boolean().optional(),
    unfinishedness_bias: z.number().min(0).max(1).optional(),
    // invariant: optional governance warnings forwarded from the
    // RecallCandidate. Older agents that do not understand the field
    // simply skip it; soul.resolve-aware agents and the Inspector
    // Health Inbox branch on the listed kind / severity / policy.
    // see also: staged-warning.ts (schema),
    // recall-candidate.ts (producer-side field).
    staged_warnings: StagedWarningArraySchema.optional()
  })
  .strict()
  .readonly();

export const SoulActiveConstraintGovernanceStateSchema = z
  .object({
    claim_status: ClaimLifecycleStateSchema.nullable(),
    governance_class: PathGovernanceClassSchema.nullable(),
    source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const SoulActiveConstraintSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content: NonEmptyStringSchema,
    dimension: MemoryDimensionSchema,
    scope_class: ScopeClassSchema,
    governance_state: SoulActiveConstraintGovernanceStateSchema
  })
  .strict()
  .readonly();

export const RecallTimeFieldSchema = z.enum(["created_at", "last_used_at"]);

export const SoulRecallTokenizerHintSchema = z.enum([
  "cl100k",
  "o200k",
  "approx_chars_per_token"
]);

export const SoulRecallHostContextSchema = z
  .object({
    tokenizer_hint: SoulRecallTokenizerHintSchema.optional()
  })
  .strict()
  .readonly();

export const SoulMemorySearchRequestSchema = z
  .object({
    query: BoundedQuerySchema,
    scope_class: ScopeClassSchema.nullable(),
    dimension: MemoryDimensionSchema.nullable(),
    domain_tags: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().nullable(),
    max_results: NonNegativeIntSchema.max(1000),
    // Optional time-window filter applied during coarse filter, before ranking.
    // Lets agents answer queries like "what did I say on May 20" without breaking
    // the score function. `time_field` selects which timestamp the bounds apply to.
    since: IsoDatetimeStringSchema.nullable().optional(),
    until: IsoDatetimeStringSchema.nullable().optional(),
    time_field: RecallTimeFieldSchema.optional(),
    host_context: SoulRecallHostContextSchema.optional(),
    // The host's latest verbatim user message. Carried so the memory plane
    // can passively extract durable candidates from the turn the host is
    // already recalling for, without depending on the host echoing a
    // turn_digest on report_context_usage. Falls back to `query` when absent.
    recent_turn: BoundedQuerySchema.optional(),
    // Host wall-clock for the turn being recalled. When present, Garden
    // auto-extract uses it as source_observed_at; otherwise enqueue clock.
    source_observed_at: IsoDatetimeStringSchema.optional(),
    active_constraints_cap: NonNegativeIntSchema.max(50).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.since === null || value.since === undefined || value.until === null || value.until === undefined) {
      return;
    }
    if (Date.parse(value.since) > Date.parse(value.until)) {
      context.addIssue({
        code: "custom",
        path: ["since"],
        message: "since must be less than or equal to until."
      });
    }
  })
  .readonly();

export const SoulMemorySearchResponseSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    // Additive response marker for sibling consumers. Older daemons omit it;
    // newer ones emit the current protocol value without changing the rest of
    // the recall payload shape.
    protocol_version: NonNegativeIntSchema.min(1).optional(),
    results: z.array(MemorySearchResultSchema).readonly(),
    active_constraints: z.array(SoulActiveConstraintSchema).readonly().optional(),
    active_constraints_count: NonNegativeIntSchema.optional(),
    total_count: NonNegativeIntSchema,
    strategy_mix: SoulRecallStrategyMixSchema,
    degradation_reason: SoulMemorySearchDegradationReasonSchema.nullable().optional(),
    delivery_path: z.enum(["legacy", "canonical"]).optional(),
    ranking_authority: z.enum(["prefix_sk", "select_gamma"]).optional(),
    capture_identity: z.object({
      algorithm_id: NonEmptyStringSchema,
      version: NonEmptyStringSchema,
      digest: NonEmptyStringSchema
    }).strict().readonly().optional(),
    capture_execution: CaptureExecutionSchema.optional()
  })
  .strict()
  .readonly();

export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
export type SoulActiveConstraintGovernanceState = z.infer<typeof SoulActiveConstraintGovernanceStateSchema>;
export type SoulActiveConstraint = z.infer<typeof SoulActiveConstraintSchema>;
export type SoulRecallStrategyMix = z.infer<typeof SoulRecallStrategyMixSchema>;
export type SoulMemorySearchDegradationReason = z.infer<typeof SoulMemorySearchDegradationReasonSchema>;
export type SoulRecallTokenizerHint = z.infer<typeof SoulRecallTokenizerHintSchema>;
export type SoulRecallHostContext = z.infer<typeof SoulRecallHostContextSchema>;
export type SoulMemorySearchRequest = z.infer<typeof SoulMemorySearchRequestSchema>;
export type SoulMemorySearchResponse = z.infer<typeof SoulMemorySearchResponseSchema>;
