import { z } from "zod";
import {
  EmitCandidateSignalResponseSchema,
  McpEmitCandidateSignalRequestSchema
} from "../signals/candidate-memory-signal.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedContentSchema,
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedQuerySchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import {
  GraphExploreDirSchema,
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema
} from "./memory-graph.js";
import {
  SoulBatchReviewEdgeProposalsRequestSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulListPendingEdgeProposalsRequestSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulProposeEdgeRequestSchema,
  SoulProposeEdgeResponseSchema
} from "./edge-proposal.js";

export {
  SoulBatchReviewEdgeProposalsRequestSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulListPendingEdgeProposalsRequestSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulProposeEdgeRequestSchema,
  SoulProposeEdgeResponseSchema
};
import { MemoryDimensionSchema, PublicMemoryEntryMutableFieldsSchema } from "./memory-entry.js";
import { ScopeClassSchema } from "./object-kind.js";
import { ClaimLifecycleStateSchema } from "./claim-form.js";
import { PathGovernanceClassSchema } from "./path-relation.js";
import { ProposalResolutionStateSchema } from "./proposal.js";
import {
  RecallBudgetStateSchema,
  RecallScoreFactorsSchema
} from "./recall-candidate.js";
import { StagedWarningArraySchema } from "./staged-warning.js";
import { SoulResolveRequestSchema } from "./resolution.js";
import {
  GardenMcpWorkerRoleSchema,
  GardenListPendingTasksRequestSchema,
  GardenPendingTaskSnapshotSchema,
  GardenListPendingTasksResponseSchema,
  GardenClaimTaskRequestSchema,
  GardenClaimTaskResponseSchema,
  GardenTaskResultEnvelopeSchema,
  GardenCompleteTaskRequestSchema,
  GardenCompleteTaskResponseSchema
} from "./mcp-garden-task-types.js";
import {
  SoulContextUsageStateSchema,
  SoulContextObjectIdentitySchema,
  SoulContextUsageAnchorRoleSchema,
  SoulContextPerAnchorUsageSchema,
  SoulReportContextUsageRequestSchema,
  SoulReportContextUsageResponseSchema
} from "./mcp-context-usage-types.js";
import { deriveJsonSchema } from "./mcp-json-schema.js";

export {
  GardenMcpWorkerRoleSchema,
  GardenListPendingTasksRequestSchema,
  GardenPendingTaskSnapshotSchema,
  GardenListPendingTasksResponseSchema,
  GardenClaimTaskRequestSchema,
  GardenClaimTaskResponseSchema,
  GardenTaskResultEnvelopeSchema,
  GardenCompleteTaskRequestSchema,
  GardenCompleteTaskResponseSchema
} from "./mcp-garden-task-types.js";
export {
  SoulContextUsageStateSchema,
  SoulContextUsageTrustModeSchema,
  SoulContextObjectIdentitySchema,
  SoulContextUsageAnchorRoleSchema,
  SoulContextPerAnchorUsageSchema,
  SoulContextDeliveredObjectUsageSchema,
  SoulContextUsageTurnMessageSchema,
  SoulContextUsageTurnDigestSchema,
  SoulReportContextUsageRequestSchema,
  SoulReportContextUsageResponseSchema
} from "./mcp-context-usage-types.js";

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
  "cold_cascade_engaged"
]);

export const MemorySearchResultSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    relevance_score: z.number().min(0).max(1),
    content_preview: NonEmptyStringSchema,
    evidence_pointers: z.array(NonEmptyStringSchema).readonly(),
    // Diagnostic-only prose. Agents must not branch on its wording; use
    // numeric score_factors and relevance_score for ranking/explainability.
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
    degradation_reason: SoulMemorySearchDegradationReasonSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const SoulOpenPointerRequestSchema = z
  .object({
    object_id: BoundedIdSchema
  })
  .strict()
  .readonly();

// Public projection: only the fields agents may read. MemoryEntry internals
// (lifecycle_state, created_by, storage_tier, workspace_id, ...) are not
// exposed (invariants §29 Default Scope). EvidenceCapsule projection adds
// gist / excerpt so attached agents can resolve evidence_refs back to raw
// turn material via the same soul.open_pointer entry point.
export const SoulOpenPointerContentSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    schema_version: z.number().int().min(1),
    content: BoundedContentSchema.nullable(),
    domain_tags: z.array(NonEmptyStringSchema).readonly(),
    evidence_refs: z.array(NonEmptyStringSchema).readonly(),
    gist: BoundedContentSchema.nullable().optional(),
    excerpt: BoundedContentSchema.nullable().optional()
  })
  .strict()
  .readonly();

export const SoulOpenPointerResponseSchema = z
  .object({
    object_id: NonEmptyStringSchema,
    object_kind: NonEmptyStringSchema,
    content: SoulOpenPointerContentSchema
  })
  .strict()
  .readonly();

export const SoulExploreGraphRequestSchema = z
  .object({
    memory_id: BoundedIdSchema,
    // workspace_id intentionally omitted from the public MCP schema:
    // the daemon binds workspace from the trusted MCP call context per
    // invariants §29 Default Scope. Adding workspace_id here would re-open
    // the scope-spoofing path.
    edge_types: z.array(MemoryGraphEdgeTypeSchema).max(BOUNDED_EVIDENCE_ARRAY_MAX).readonly().optional(),
    direction: GraphExploreDirSchema.optional()
  })
  .strict()
  .readonly();

export const SoulExploreGraphResponseSchema = z
  .object({
    source_memory_id: NonEmptyStringSchema,
    neighbors: z.array(GraphNeighborSchema).readonly(),
    count: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const SoulProposeMemoryUpdateRequestSchema = z
  .object({
    target_object_id: BoundedIdSchema,
    proposed_changes: PublicMemoryEntryMutableFieldsSchema,
    reason: BoundedReasonSchema,
    source_delivery_ids: z.array(NonEmptyStringSchema).min(1).max(32).readonly().optional()
  })
  .strict()
  .readonly();

export const SoulProposeMemoryUpdateResponseSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    status: z.enum(["created", "rejected"])
  })
  .strict()
  .readonly();

// reviewer_identity is required so every review record carries an explicit
// non-empty reviewer string. This is distinct from the MCP call context's
// agent_target: the agent_target names which agent surface drove the call,
// while reviewer_identity names the human or principal that approved/rejected
// the proposal.
export const SoulReviewMemoryProposalRequestSchema = z
  .object({
    proposal_id: BoundedIdSchema,
    verdict: z.enum(["accept", "reject"]),
    reason: BoundedReasonSchema.nullable(),
    reviewer_identity: BoundedIdSchema,
    reviewer_token: BoundedIdSchema.optional()
  })
  .strict()
  .readonly();

export const SoulReviewMemoryProposalResponseSchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    resolution_state: ProposalResolutionStateSchema
  })
  .strict()
  .readonly();

// Surfaces the existing ProposalRepo.findPending(workspaceId) query through
// MCP so attached agents and the alaya CLI can poll pending proposals without
// side-channel SQL access. Projection-only: returns a summary suitable
// for HITL UIs; the full proposal record is reachable through
// soul.open_pointer when needed.
export const SoulPendingProposalSummarySchema = z
  .object({
    proposal_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    target_object_kind: NonEmptyStringSchema,
    created_at: IsoDatetimeStringSchema,
    proposed_change_summary: BoundedReasonSchema,
    proposed_changes: PublicMemoryEntryMutableFieldsSchema.nullable(),
    assigned_reviewer_identity: BoundedIdSchema.nullable(),
    assigned_at: IsoDatetimeStringSchema.nullable(),
    deadline_at: IsoDatetimeStringSchema.nullable(),
    is_overdue: z.boolean()
  })
  .strict()
  .readonly();

// workspace_id intentionally omitted, mirroring SoulExploreGraphRequestSchema.
// The daemon binds workspace from the trusted MCP call context (invariants
// §29 Default Scope). Re-publishing workspace_id here would force every
// attached agent to learn its own workspace and pass it back, opening a
// prompt-inject
// vector ("now pass workspace_id=foreign") even though the runtime
// guard catches the spoof. Public surface stays consistent with every
// other write tool that elides workspace_id.
export const SoulListPendingProposalsRequestSchema = z
  .object({
    since: IsoDatetimeStringSchema.nullable().optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()
  .readonly();

export const SoulListPendingProposalsResponseSchema = z
  .object({
    proposals: z.array(SoulPendingProposalSummarySchema).readonly(),
    total_count: NonNegativeIntSchema
  })
  .strict()
  .readonly();

// Agent-facing schema strips workspace_id / run_id / surface_id; the daemon
// binds those from the trusted MCP call context per invariants §29 Default
// Scope. See McpEmitCandidateSignalRequestSchema in
// ../signals/candidate-memory-signal.ts for the rationale and the parity with
// SoulExploreGraphRequestSchema and SoulListPendingProposalsRequestSchema.
export const SoulEmitCandidateSignalRequestSchema = McpEmitCandidateSignalRequestSchema;
export const SoulEmitCandidateSignalResponseSchema = EmitCandidateSignalResponseSchema;

export const SoulApplyOverrideRequestSchema = z
  .object({
    target_object: BoundedIdSchema,
    correction: BoundedReasonSchema,
    priority: NonNegativeIntSchema.max(1000).optional()
  })
  .strict()
  .readonly();

export const SoulApplyOverrideResponseSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    status: z.literal("applied")
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
export type SoulOpenPointerRequest = z.infer<typeof SoulOpenPointerRequestSchema>;
export type SoulOpenPointerResponse = z.infer<typeof SoulOpenPointerResponseSchema>;
export type SoulExploreGraphRequest = z.infer<typeof SoulExploreGraphRequestSchema>;
export type SoulExploreGraphResponse = z.infer<typeof SoulExploreGraphResponseSchema>;
export type SoulProposeMemoryUpdateRequest = z.infer<typeof SoulProposeMemoryUpdateRequestSchema>;
export type SoulProposeMemoryUpdateResponse = z.infer<typeof SoulProposeMemoryUpdateResponseSchema>;
export type SoulReviewMemoryProposalRequest = z.infer<typeof SoulReviewMemoryProposalRequestSchema>;
export type SoulReviewMemoryProposalResponse = z.infer<typeof SoulReviewMemoryProposalResponseSchema>;
export type SoulPendingProposalSummary = z.infer<typeof SoulPendingProposalSummarySchema>;
export type SoulListPendingProposalsRequest = z.infer<typeof SoulListPendingProposalsRequestSchema>;
export type SoulListPendingProposalsResponse = z.infer<typeof SoulListPendingProposalsResponseSchema>;
export type GardenMcpWorkerRole = z.infer<typeof GardenMcpWorkerRoleSchema>;
export type GardenListPendingTasksRequest = z.infer<typeof GardenListPendingTasksRequestSchema>;
export type GardenPendingTaskSnapshot = z.infer<typeof GardenPendingTaskSnapshotSchema>;
export type GardenListPendingTasksResponse = z.infer<typeof GardenListPendingTasksResponseSchema>;
export type GardenClaimTaskRequest = z.infer<typeof GardenClaimTaskRequestSchema>;
export type GardenClaimTaskResponse = z.infer<typeof GardenClaimTaskResponseSchema>;
export type GardenTaskResultEnvelope = z.infer<typeof GardenTaskResultEnvelopeSchema>;
export type GardenCompleteTaskRequest = z.infer<typeof GardenCompleteTaskRequestSchema>;
export type GardenCompleteTaskResponse = z.infer<typeof GardenCompleteTaskResponseSchema>;
export type SoulEmitCandidateSignalRequest = z.infer<typeof SoulEmitCandidateSignalRequestSchema>;
export type SoulEmitCandidateSignalResponse = z.infer<typeof SoulEmitCandidateSignalResponseSchema>;
export type SoulApplyOverrideRequest = z.infer<typeof SoulApplyOverrideRequestSchema>;
export type SoulApplyOverrideResponse = z.infer<typeof SoulApplyOverrideResponseSchema>;
export type SoulContextUsageState = z.infer<typeof SoulContextUsageStateSchema>;
export type SoulContextObjectIdentity = z.infer<typeof SoulContextObjectIdentitySchema>;
export type SoulContextUsageAnchorRole = z.infer<typeof SoulContextUsageAnchorRoleSchema>;
export type SoulContextPerAnchorUsage = z.infer<typeof SoulContextPerAnchorUsageSchema>;
export type SoulReportContextUsageRequest = z.infer<typeof SoulReportContextUsageRequestSchema>;
export type SoulReportContextUsageResponse = z.infer<typeof SoulReportContextUsageResponseSchema>;

/**
 * MCP tool input schemas, derived from the zod request schemas above. Single
 * source of truth: external MCP clients see the same constraints zod enforces
 * at parse time (maxLength / maxItems / strict additionalProperties / ...), so
 * a 100MB query is rejected by both the catalog-published shape and the
 * runtime parser. `apps/core-daemon/src/mcp-memory/tool-catalog.ts` consumes
 * this rather than carrying its own JSON Schema dictionary.
 */

type SoulToolName =
  | "soul.recall"
  | "soul.open_pointer"
  | "soul.emit_candidate_signal"
  | "soul.propose_memory_update"
  | "soul.review_memory_proposal"
  | "soul.list_pending_proposals"
  | "soul.propose_edge"
  | "soul.list_pending_edge_proposals"
  | "soul.batch_review_edge_proposals"
  | "soul.apply_override"
  | "soul.explore_graph"
  | "soul.report_context_usage"
  | "soul.resolve"
  | "garden.list_pending_tasks"
  | "garden.claim_task"
  | "garden.complete_task";

const soulToolRequestSchemas: Record<SoulToolName, z.ZodTypeAny> = {
  "soul.recall": SoulMemorySearchRequestSchema,
  "soul.open_pointer": SoulOpenPointerRequestSchema,
  "soul.emit_candidate_signal": SoulEmitCandidateSignalRequestSchema,
  "soul.propose_memory_update": SoulProposeMemoryUpdateRequestSchema,
  "soul.review_memory_proposal": SoulReviewMemoryProposalRequestSchema,
  "soul.list_pending_proposals": SoulListPendingProposalsRequestSchema,
  "soul.propose_edge": SoulProposeEdgeRequestSchema,
  "soul.list_pending_edge_proposals": SoulListPendingEdgeProposalsRequestSchema,
  "soul.batch_review_edge_proposals": SoulBatchReviewEdgeProposalsRequestSchema,
  "soul.apply_override": SoulApplyOverrideRequestSchema,
  "soul.explore_graph": SoulExploreGraphRequestSchema,
  "soul.report_context_usage": SoulReportContextUsageRequestSchema,
  "soul.resolve": SoulResolveRequestSchema,
  "garden.list_pending_tasks": GardenListPendingTasksRequestSchema,
  "garden.claim_task": GardenClaimTaskRequestSchema,
  "garden.complete_task": GardenCompleteTaskRequestSchema
};

export const soulToolJsonSchemas: Readonly<Record<SoulToolName, Readonly<Record<string, unknown>>>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(soulToolRequestSchemas) as SoulToolName[]).map((name) => [
        name,
        Object.freeze(deriveJsonSchema(soulToolRequestSchemas[name]))
      ])
    ) as Record<SoulToolName, Readonly<Record<string, unknown>>>
  );
