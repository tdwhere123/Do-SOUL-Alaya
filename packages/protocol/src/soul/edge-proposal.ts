import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import { MemoryGraphEdgeTypeSchema } from "./memory-graph.js";

const edgeProposalStatusValues = [
  "pending",
  "accepted",
  "rejected",
  "expired",
  "auto_accepted"
] as const;

// invariant: trigger_source values map 1:1 to the edge producers +
// governance entrypoints. `llm_supports` is reserved for the LLM
// pair-classifier path; the rule-based local fallbacks tag themselves with
// `local_supports` / `local_supersedes` / `local_derives_from` so KPI K3.2
// per-trigger breakdown stays unambiguous (do not collapse local heuristics
// back onto `system`).
const edgeProposalTriggerSourceValues = [
  "explicit",
  "candidate_signal_ref",
  "conflict_detection",
  "recall_cross_link",
  "bench_seed",
  "llm_supports",
  "local_supports",
  "local_supersedes",
  "local_contradicts",
  "local_derives_from",
  "system"
] as const;

export const EdgeProposalStatus = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  EXPIRED: "expired",
  AUTO_ACCEPTED: "auto_accepted"
} as const;

export const EdgeProposalTriggerSource = {
  EXPLICIT: "explicit",
  CANDIDATE_SIGNAL_REF: "candidate_signal_ref",
  CONFLICT_DETECTION: "conflict_detection",
  RECALL_CROSS_LINK: "recall_cross_link",
  BENCH_SEED: "bench_seed",
  LLM_SUPPORTS: "llm_supports",
  LOCAL_SUPPORTS: "local_supports",
  LOCAL_SUPERSEDES: "local_supersedes",
  LOCAL_CONTRADICTS: "local_contradicts",
  LOCAL_DERIVES_FROM: "local_derives_from",
  SYSTEM: "system"
} as const;

export const EdgeProposalStatusSchema = z.enum(edgeProposalStatusValues);
export const EdgeProposalTriggerSourceSchema = z.enum(edgeProposalTriggerSourceValues);

export const EdgeProposalSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    trigger_source: EdgeProposalTriggerSourceSchema,
    confidence: z.number().min(0).max(1),
    reason: BoundedReasonSchema.nullable(),
    source_signal_id: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema.nullable(),
    status: EdgeProposalStatusSchema,
    reviewer_identity: NonEmptyStringSchema.nullable(),
    review_reason: BoundedReasonSchema.nullable(),
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema.nullable()
  })
  .strict()
  .readonly();

const EdgeProposalFilterFieldsSchema = z.object({
  proposal_ids: z.array(BoundedIdSchema).min(1).max(100).readonly().optional(),
  edge_type: MemoryGraphEdgeTypeSchema.optional(),
  trigger_source: EdgeProposalTriggerSourceSchema.optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  since: IsoDatetimeStringSchema.nullable().optional(),
  limit: z.number().int().min(1).max(100).optional()
});

export const EdgeProposalFilterSchema = EdgeProposalFilterFieldsSchema.strict().readonly();

export const SoulProposeEdgeRequestSchema = z
  .object({
    source_memory_id: BoundedIdSchema,
    target_memory_id: BoundedIdSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    confidence: z.number().min(0).max(1).default(0.5),
    reason: BoundedReasonSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const SoulProposeEdgeResponseSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    status: EdgeProposalStatusSchema
  })
  .strict()
  .readonly();

export const SoulPendingEdgeProposalSummarySchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    trigger_source: EdgeProposalTriggerSourceSchema,
    confidence: z.number().min(0).max(1),
    reason: BoundedReasonSchema.nullable(),
    source_signal_id: NonEmptyStringSchema.nullable(),
    run_id: NonEmptyStringSchema.nullable(),
    created_at: IsoDatetimeStringSchema,
    expires_at: IsoDatetimeStringSchema.nullable()
  })
  .strict()
  .readonly();

export const SoulListPendingEdgeProposalsRequestSchema = EdgeProposalFilterFieldsSchema.omit({
  proposal_ids: true
})
  .strict()
  .readonly();

export const SoulListPendingEdgeProposalsResponseSchema = z
  .object({
    proposals: z.array(SoulPendingEdgeProposalSummarySchema).readonly(),
    total_count: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const SoulBatchReviewEdgeProposalsRequestSchema = z
  .object({
    verdict: z.enum(["accept", "reject"]),
    filter: EdgeProposalFilterSchema,
    reason: BoundedReasonSchema.nullable(),
    reviewer_identity: BoundedIdSchema,
    reviewer_token: BoundedIdSchema.optional()
  })
  .strict()
  .readonly();

export const SoulBatchReviewEdgeProposalsResponseSchema = z
  .object({
    accepted_count: NonNegativeIntSchema,
    rejected_count: NonNegativeIntSchema,
    reviewed_proposal_ids: z.array(NonEmptyStringSchema).readonly()
  })
  .strict()
  .readonly();

export type EdgeProposalStatusValue = z.infer<typeof EdgeProposalStatusSchema>;
export type EdgeProposalTriggerSourceValue = z.infer<typeof EdgeProposalTriggerSourceSchema>;
export type EdgeProposal = z.infer<typeof EdgeProposalSchema>;
export type EdgeProposalFilter = z.infer<typeof EdgeProposalFilterSchema>;
export type SoulProposeEdgeRequest = z.infer<typeof SoulProposeEdgeRequestSchema>;
export type SoulProposeEdgeResponse = z.infer<typeof SoulProposeEdgeResponseSchema>;
export type SoulPendingEdgeProposalSummary = z.infer<typeof SoulPendingEdgeProposalSummarySchema>;
export type SoulListPendingEdgeProposalsRequest = z.infer<typeof SoulListPendingEdgeProposalsRequestSchema>;
export type SoulListPendingEdgeProposalsResponse = z.infer<typeof SoulListPendingEdgeProposalsResponseSchema>;
export type SoulBatchReviewEdgeProposalsRequest = z.infer<typeof SoulBatchReviewEdgeProposalsRequestSchema>;
export type SoulBatchReviewEdgeProposalsResponse = z.infer<typeof SoulBatchReviewEdgeProposalsResponseSchema>;
