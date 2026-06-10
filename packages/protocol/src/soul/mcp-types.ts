import { z } from "zod";
import {
  CandidateMemorySignalContentSchema,
  EmitCandidateSignalResponseSchema,
  McpEmitCandidateSignalRequestSchema
} from "../signals/candidate-memory-signal.js";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BOUNDED_EVIDENCE_ARRAY_MAX,
  BoundedIdSchema,
  BoundedJsonObjectSchema,
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
import { EdgeClassifyVerdictSchema } from "./garden-tier.js";
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

const GARDEN_COMPLETE_CANDIDATE_SIGNAL_MAX = 64;
const GARDEN_COMPLETE_EXTRACTED_PROPOSAL_MAX = 32;

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
    selection_reason: BoundedReasonSchema,
    source_channels: z.array(BoundedLabelSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
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
    active_constraints_cap: NonNegativeIntSchema.max(50).optional()
  })
  .readonly();

export const SoulMemorySearchResponseSchema = z
  .object({
    delivery_id: NonEmptyStringSchema,
    results: z.array(MemorySearchResultSchema).readonly(),
    active_constraints: z.array(SoulActiveConstraintSchema).readonly().optional(),
    active_constraints_count: NonNegativeIntSchema.optional(),
    total_count: NonNegativeIntSchema,
    strategy_mix: SoulRecallStrategyMixSchema,
    degradation_reason: SoulMemorySearchDegradationReasonSchema.nullable().optional()
  })
  .readonly();

export const SoulOpenPointerRequestSchema = z
  .object({
    object_id: BoundedIdSchema
  })
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
    content: z.string().nullable(),
    domain_tags: z.array(NonEmptyStringSchema).readonly(),
    evidence_refs: z.array(NonEmptyStringSchema).readonly(),
    gist: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional()
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
    // invariants §29 Default Scope. Adding workspace_id here would re-open
    // the scope-spoofing path.
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
    created_at: z.string().datetime(),
    proposed_change_summary: z.string(),
    proposed_changes: PublicMemoryEntryMutableFieldsSchema.nullable(),
    assigned_reviewer_identity: NonEmptyStringSchema.nullable(),
    assigned_at: z.string().datetime().nullable(),
    deadline_at: z.string().datetime().nullable(),
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
    since: z.string().datetime().nullable().optional(),
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

export const GardenMcpWorkerRoleSchema = z.enum([
  "janitor",
  "auditor",
  "librarian",
  "host_worker"
]);

export const GardenListPendingTasksRequestSchema = z
  .object({
    role: GardenMcpWorkerRoleSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict()
  .readonly();

export const GardenPendingTaskSnapshotSchema = z
  .object({
    task_id: BoundedIdSchema,
    role: BoundedLabelSchema,
    kind: BoundedLabelSchema,
    created_at: z.string(),
    payload: z.unknown()
  })
  .strict()
  .readonly();

export const GardenListPendingTasksResponseSchema = z
  .object({
    tasks: z.array(GardenPendingTaskSnapshotSchema).readonly()
  })
  .strict()
  .readonly();

export const GardenClaimTaskRequestSchema = z
  .object({
    task_id: BoundedIdSchema
  })
  .strict()
  .readonly();

export const GardenClaimTaskResponseSchema = z
  .object({
    status: z.enum(["claimed", "already_claimed"]),
    task_id: BoundedIdSchema,
    role: BoundedLabelSchema,
    kind: BoundedLabelSchema,
    payload: z.unknown()
  })
  .strict()
  .readonly();

// The garden.complete_task result envelope is the discriminated result type
// for the two host-worker task kinds:
//   - POST_TURN_EXTRACT reports `candidate_signals` (anchor-free CONTENT-ONLY
//     shape; the daemon binds workspace_id / run_id / surface_id / source from
//     trusted MCP context + the claimed task row, and Garden-originated
//     extraction has no prior recall delivery to attribute).
//   - EDGE_CLASSIFY reports `edge_verdict` (the supports/derives_from/none
//     pair judgement). The daemon refines the existing heuristic path with the
//     verdict; a "none"/below-floor verdict refines nothing and the inline
//     heuristic verdict stands.
// invariant: exactly one result shape is meaningful per task kind. The handler
// rejects a candidate_signals envelope on an EDGE_CLASSIFY task and an
// edge_verdict envelope on a POST_TURN_EXTRACT task, so a host cannot smuggle
// the wrong result type into a claimed task.
export const GardenTaskResultEnvelopeSchema = z
  .object({
    candidate_signals: z
      .array(CandidateMemorySignalContentSchema)
      .max(GARDEN_COMPLETE_CANDIDATE_SIGNAL_MAX)
      .readonly()
      .optional(),
    edge_verdict: EdgeClassifyVerdictSchema.optional(),
    extracted_proposals: z
      .array(BoundedJsonObjectSchema)
      .max(GARDEN_COMPLETE_EXTRACTED_PROPOSAL_MAX)
      .readonly()
      .optional(),
    notes: BoundedReasonSchema.optional()
  })
  .strict()
  .readonly();

export const GardenCompleteTaskRequestSchema = z
  .object({
    task_id: BoundedIdSchema,
    status: z.enum(["completed", "failed"]),
    result_envelope: GardenTaskResultEnvelopeSchema.optional(),
    last_error_text: BoundedReasonSchema.optional()
  })
  .strict()
  .readonly();

export const GardenCompleteTaskResponseSchema = z
  .object({
    task_id: BoundedIdSchema,
    status: z.enum(["completed", "failed"]),
    events_appended: NonNegativeIntSchema
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
  .readonly();

export const SoulApplyOverrideResponseSchema = z
  .object({
    override_id: NonEmptyStringSchema,
    status: z.literal("applied")
  })
  .readonly();

export const SoulContextUsageStateSchema = z.enum(["used", "skipped", "not_applicable"]);
export const SoulContextUsageTrustModeSchema = z.enum(["manual", "automatic"]);

// object_kind is an open BoundedLabel, not a closed enum, on purpose: it is
// the same open vocabulary as SoulActiveConstraint.object_kind and must admit
// kinds the wire does not yet model. Consumers fail closed — an unknown kind
// simply never tuple-matches a delivered/expected (object_id, object_kind).
export const SoulContextObjectIdentitySchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageAnchorRoleSchema = z.enum(["source", "target"]);

export const SoulContextPerAnchorUsageSchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema.optional(),
    anchor_role: SoulContextUsageAnchorRoleSchema
  })
  .strict()
  .readonly();

export const SoulContextDeliveredObjectUsageSchema = z
  .object({
    object_id: BoundedIdSchema,
    object_kind: BoundedLabelSchema.optional(),
    usage_status: SoulContextUsageStateSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageTurnMessageSchema = z
  .object({
    role: BoundedLabelSchema,
    content_excerpt: BoundedReasonSchema
  })
  .strict()
  .readonly();

export const SoulContextUsageTurnDigestSchema = z
  .object({
    last_messages: z.array(SoulContextUsageTurnMessageSchema).max(50).readonly().default([])
  })
  .strict()
  .readonly();

export const SoulReportContextUsageRequestSchema = z
  .object({
    delivery_id: BoundedIdSchema,
    usage_state: SoulContextUsageStateSchema,
    used_object_ids: z.array(BoundedIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    delivered_objects: z
      .array(SoulContextDeliveredObjectUsageSchema)
      .max(BOUNDED_DEFAULT_ARRAY_MAX)
      .readonly()
      .optional(),
    turn_index: NonNegativeIntSchema.optional(),
    turn_digest: SoulContextUsageTurnDigestSchema.optional(),
    per_anchor_usage: z.array(SoulContextPerAnchorUsageSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly().optional(),
    // invariant (agents propose, Alaya decides): trust_mode is NOT a
    // request field. Usage trust weight is server-derived — an MCP usage
    // report is an unverified agent self-report, always recorded as
    // `automatic` (lower path-plasticity weight). A caller cannot
    // self-declare `manual` to claim full reinforcement weight. The
    // SoulContextUsageTrustModeSchema enum still types the durable
    // UsageProofRecord, where the server sets the mode.
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
 * runtime parser. `apps/core-daemon/src/mcp-memory-tool-catalog.ts` consumes
 * this rather than carrying its own JSON Schema dictionary.
 */
import { zodToJsonSchema } from "zod-to-json-schema";

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
