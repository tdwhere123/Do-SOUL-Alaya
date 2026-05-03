import { z } from "zod";
import { EmitCandidateSignalRequestSchema, EmitCandidateSignalResponseSchema } from "../candidate-memory-signal.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedQuerySchema,
  BoundedReasonSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import {
  GraphExploreDirSchema,
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema
} from "./memory-graph.js";
import { MemoryDimensionSchema, PublicMemoryEntryMutableFieldsSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";
import { ProposalResolutionStateSchema } from "./proposal.js";

export const MemorySearchResultSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    relevance_score: z.number().min(0).max(1),
    content_preview: NonEmptyStringSchema,
    evidence_pointers: z.array(NonEmptyStringSchema).readonly()
  })
  .readonly();

export const SoulMemorySearchRequestSchema = z
  .object({
    query: BoundedQuerySchema,
    scope_class: ScopeClassSchema.nullable(),
    dimension: MemoryDimensionSchema.nullable(),
    domain_tags: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().nullable(),
    max_results: NonNegativeIntSchema.max(1000)
  })
  .readonly();

export const SoulMemorySearchResponseSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    results: z.array(MemorySearchResultSchema).readonly(),
    total_count: NonNegativeIntSchema
  })
  .readonly();

export const SoulOpenPointerRequestSchema = z
  .object({
    object_id: BoundedIdSchema
  })
  .readonly();

// Public projection: only the fields agents may read. MemoryEntry internals
// (lifecycle_state, created_by, storage_tier, workspace_id, ...) are not
// exposed (p5-system-review-r3 MR-I05 / invariants §29 Default Scope).
export const SoulOpenPointerContentSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    schema_version: z.number().int().min(1),
    content: z.string().nullable(),
    domain_tags: z.array(NonEmptyStringSchema).readonly(),
    evidence_refs: z.array(NonEmptyStringSchema).readonly()
  })
  .readonly();

export const SoulOpenPointerResponseSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content: SoulOpenPointerContentSchema
  })
  .readonly();

export const SoulExploreGraphRequestSchema = z
  .object({
    memory_id: BoundedIdSchema,
    // workspace_id intentionally omitted from the public MCP schema:
    // the daemon binds workspace from the trusted MCP call context per
    // invariants §29 Default Scope and p5-system-review-r2 F-r2-001.
    // Adding workspace_id here would re-open the scope-spoofing path.
    edge_types: z.array(MemoryGraphEdgeTypeSchema).max(BOUNDED_EVIDENCE_ARRAY_MAX).readonly().optional(),
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
    target_object_id: BoundedIdSchema,
    proposed_changes: PublicMemoryEntryMutableFieldsSchema,
    reason: BoundedReasonSchema
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
    proposal_id: BoundedIdSchema,
    verdict: z.enum(["accept", "reject"]),
    reason: BoundedReasonSchema.nullable()
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
    target_object: BoundedIdSchema,
    correction: BoundedReasonSchema,
    priority: NonNegativeIntSchema.max(1000).optional()
  })
  .readonly();

export const SoulApplyOverrideResponseSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    status: z.literal("applied")
  })
  .readonly();

export const SoulContextUsageStateSchema = z.enum(["used", "skipped", "not_applicable"]);

export const SoulReportContextUsageRequestSchema = z
  .object({
    delivery_id: BoundedIdSchema,
    usage_state: SoulContextUsageStateSchema,
    used_object_ids: z.array(BoundedIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    reason: BoundedReasonSchema.nullable().optional()
  })
  .readonly();

export const SoulReportContextUsageResponseSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    status: z.literal("recorded")
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
export type SoulContextUsageState = z.infer<typeof SoulContextUsageStateSchema>;
export type SoulReportContextUsageRequest = z.infer<typeof SoulReportContextUsageRequestSchema>;
export type SoulReportContextUsageResponse = z.infer<typeof SoulReportContextUsageResponseSchema>;

/**
 * MCP tool input schemas, derived from the zod request schemas above
 * (p5-system-review-r3 MR-I04). Single source of truth: external MCP
 * clients see the same constraints zod enforces at parse time, so a
 * 100MB query is rejected by both the catalog-published shape and the
 * runtime parser.
 *
 * The previous implementation maintained a hand-written JSON Schema
 * dictionary in `apps/core-daemon/src/mcp-memory-tool-catalog.ts`
 * (`inputSchemaByToolName`) which silently drifted from the zod schemas
 * and weakened the public surface (no maxLength / maxItems / strict
 * additionalProperties). That dictionary is now derived here.
 */
import { zodToJsonSchema } from "zod-to-json-schema";

type SoulToolName =
  | "soul.recall"
  | "soul.open_pointer"
  | "soul.emit_candidate_signal"
  | "soul.propose_memory_update"
  | "soul.review_memory_proposal"
  | "soul.apply_override"
  | "soul.explore_graph"
  | "soul.report_context_usage";

const soulToolRequestSchemas: Record<SoulToolName, z.ZodTypeAny> = {
  "soul.recall": SoulMemorySearchRequestSchema,
  "soul.open_pointer": SoulOpenPointerRequestSchema,
  "soul.emit_candidate_signal": SoulEmitCandidateSignalRequestSchema,
  "soul.propose_memory_update": SoulProposeMemoryUpdateRequestSchema,
  "soul.review_memory_proposal": SoulReviewMemoryProposalRequestSchema,
  "soul.apply_override": SoulApplyOverrideRequestSchema,
  "soul.explore_graph": SoulExploreGraphRequestSchema,
  "soul.report_context_usage": SoulReportContextUsageRequestSchema
};

function deriveJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  // Strip the JSON Schema metadata fields that MCP clients do not need;
  // they would otherwise leak the upstream draft URI and inflate every
  // tools/list payload.
  delete result["$schema"];
  delete result["definitions"];
  return result;
}

export const soulToolJsonSchemas: Readonly<Record<SoulToolName, Readonly<Record<string, unknown>>>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(soulToolRequestSchemas) as SoulToolName[]).map((name) => [
        name,
        Object.freeze(deriveJsonSchema(soulToolRequestSchemas[name]))
      ])
    ) as Record<SoulToolName, Readonly<Record<string, unknown>>>
  );
