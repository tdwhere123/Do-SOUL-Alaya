import { z } from "zod";
import { EmitCandidateSignalRequestSchema, EmitCandidateSignalResponseSchema } from "../candidate-memory-signal.js";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";
import {
  GraphExploreDirSchema,
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema
} from "./memory-graph.js";
import { MemoryDimensionSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";
import { ProposalResolutionStateSchema } from "./proposal.js";

export const MemorySearchResultSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    relevance_score: z.number().min(0).max(1),
    content_preview: NonEmptyStringSchema
  })
  .readonly();

export const SoulMemorySearchRequestSchema = z
  .object({
    query: NonEmptyStringSchema,
    scope_class: ScopeClassSchema.nullable(),
    dimension: MemoryDimensionSchema.nullable(),
    domain_tags: z.array(NonEmptyStringSchema).readonly().nullable(),
    max_results: NonNegativeIntSchema
  })
  .readonly();

export const SoulMemorySearchResponseSchema = z
  .object({
    results: z.array(MemorySearchResultSchema).readonly(),
    total_count: NonNegativeIntSchema
  })
  .readonly();

export const SoulOpenPointerRequestSchema = z
  .object({
    object_id: NonEmptyStringSchema
  })
  .readonly();

export const SoulOpenPointerResponseSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content: z.record(z.unknown()).readonly()
  })
  .readonly();

export const SoulExploreGraphRequestSchema = z
  .object({
    memory_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    edge_types: z.array(MemoryGraphEdgeTypeSchema).readonly().optional(),
    direction: GraphExploreDirSchema.optional()
  })
  .readonly();

export const SoulExploreGraphResponseSchema = z
  .object({
    source_memory_id: NonEmptyStringSchema,
    neighbors: z.array(GraphNeighborSchema).readonly(),
    count: NonNegativeIntSchema
  })
  .readonly();

export const SoulProposeMemoryUpdateRequestSchema = z
  .object({
    target_object_id: NonEmptyStringSchema,
    proposed_changes: z.record(z.unknown()).readonly(),
    reason: NonEmptyStringSchema
  })
  .readonly();

export const SoulProposeMemoryUpdateResponseSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    status: z.enum(["created", "rejected"])
  })
  .readonly();

export const SoulReviewMemoryProposalRequestSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    verdict: z.enum(["accept", "reject"]),
    reason: z.string().nullable()
  })
  .readonly();

export const SoulReviewMemoryProposalResponseSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    resolution_state: ProposalResolutionStateSchema
  })
  .readonly();

export const SoulEmitCandidateSignalRequestSchema = EmitCandidateSignalRequestSchema;
export const SoulEmitCandidateSignalResponseSchema = EmitCandidateSignalResponseSchema;

export const SoulApplyOverrideRequestSchema = z
  .object({
    target_object: NonEmptyStringSchema,
    correction: NonEmptyStringSchema,
    priority: NonNegativeIntSchema.optional()
  })
  .readonly();

export const SoulApplyOverrideResponseSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    status: z.literal("applied")
  })
  .readonly();

export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;
export type SoulMemorySearchRequest = z.infer<typeof SoulMemorySearchRequestSchema>;
export type SoulMemorySearchResponse = z.infer<typeof SoulMemorySearchResponseSchema>;
export type SoulOpenPointerRequest = z.infer<typeof SoulOpenPointerRequestSchema>;
export type SoulOpenPointerResponse = z.infer<typeof SoulOpenPointerResponseSchema>;
export type SoulExploreGraphRequest = z.infer<typeof SoulExploreGraphRequestSchema>;
export type SoulExploreGraphResponse = z.infer<typeof SoulExploreGraphResponseSchema>;
export type SoulProposeMemoryUpdateRequest = z.infer<typeof SoulProposeMemoryUpdateRequestSchema>;
export type SoulProposeMemoryUpdateResponse = z.infer<typeof SoulProposeMemoryUpdateResponseSchema>;
export type SoulReviewMemoryProposalRequest = z.infer<typeof SoulReviewMemoryProposalRequestSchema>;
export type SoulReviewMemoryProposalResponse = z.infer<typeof SoulReviewMemoryProposalResponseSchema>;
export type SoulEmitCandidateSignalRequest = z.infer<typeof SoulEmitCandidateSignalRequestSchema>;
export type SoulEmitCandidateSignalResponse = z.infer<typeof SoulEmitCandidateSignalResponseSchema>;
export type SoulApplyOverrideRequest = z.infer<typeof SoulApplyOverrideRequestSchema>;
export type SoulApplyOverrideResponse = z.infer<typeof SoulApplyOverrideResponseSchema>;
