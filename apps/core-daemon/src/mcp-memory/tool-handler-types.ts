import type { DynamicsService } from "@do-soul/alaya-core";
import {
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  TaskObjectSurfaceSchema,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type EdgeClassifyVerdict,
  type EventLogEntry,
  type GardenRoleValue,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type MemoryGraphEdgeTypeValue,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type SoulBatchReviewEdgeProposalsRequest,
  type SoulListPendingEdgeProposalsRequest,
  type SoulListPendingProposalsRequest,
  type SoulMemorySearchDegradationReason,
  type SoulPendingProposalSummary,
  type SoulProposeMemoryUpdateRequest,
  type SoulRecallHostContext,
  type SoulReviewMemoryProposalRequest,
  type StorageTier,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskCompletionResult,
  GardenTaskEnqueueInput,
  GardenTaskEventInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import type { GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import type { RecallUsageHandlerDependencies } from "./recall-usage-handlers.js";
import type { createSoulResolveHandler } from "./resolve-handler.js";
import type { ReviewerIdentityBinding } from "./proposal-workflow.js";
import type { AlayaMemoryToolName } from "./tool-catalog.js";

// see also: apps/core-daemon/src/mcp-memory/resolve-handler.ts
type SoulResolveHandler = ReturnType<typeof createSoulResolveHandler>;

type MemoryUsageRefreshFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
// invariant: delivered pairs accrue co-recall only when the embedding-side
// coherence gate returns their canonical unordered pair key.
// see also: packages/core/src/path-graph/path-relation-proposal-service.ts:onCoRecall allowedPairKeys.
// see also: packages/core/src/embedding-recall/service.ts:EmbeddingRecallService.coherentPairKeys.

export interface McpMemoryToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  // Session id is the trusted unique counter for "an MCP attach session"
  // — required so the metering service can compute attached-agent
  // session distributions even when ALAYA_RUN_ID is not set. Generated
  // once per attach for stdio (process-stable) and per call for HTTP /
  // CLI surfaces.
  readonly sessionId: string;
  readonly surfaceId?: string | null;
}

export interface McpMemoryToolHandlerDependencies {
  readonly zeroDayToolAccess?: Readonly<{
    enforceToolAccess(workspaceId: string, toolName: string): Promise<void>;
  }>;
  readonly recallService: {
    recall(params: {
      readonly taskSurface: ReturnType<typeof TaskObjectSurfaceSchema.parse>;
      readonly workspaceId: string;
      readonly strategy: "chat" | "analyze" | "build" | "govern";
      readonly runId?: string | null;
      readonly policyOverride?: Readonly<RecallPolicy>;
      readonly timeFilter?: Readonly<{
        readonly since?: string | null;
        readonly until?: string | null;
        readonly field?: "created_at" | "last_used_at";
      }>;
      readonly hostContext?: Readonly<SoulRecallHostContext>;
      readonly activeConstraintsCap?: number | null;
    }): Promise<Readonly<{
      readonly candidates: readonly Readonly<RecallCandidate>[];
      readonly active_constraints: readonly Readonly<SoulActiveConstraint>[];
      readonly active_constraints_count: number;
      readonly total_scanned: number;
      readonly coarse_filter_count: number;
      readonly fine_assessment_count: number;
      readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
    }>>;
  };
  readonly memoryService: {
    findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
    findByIdScoped(
      objectId: string,
      workspaceId: string
    ): Promise<Readonly<MemoryEntry> | null>;
    findByIdsScoped?(
      objectIds: readonly string[],
      workspaceId: string
    ): Promise<readonly Readonly<MemoryEntry>[]>;
    update(
      objectId: string,
      fields: MemoryUsageRefreshFields,
      reason: string
    ): Promise<Readonly<MemoryEntry>>;
    updateScoped?(
      objectId: string,
      workspaceId: string,
      fields: MemoryUsageRefreshFields,
      reason: string
    ): Promise<Readonly<MemoryEntry>>;
    validateUpdate?(
      objectId: string,
      fields: MemoryEntryMutableFields
    ): Promise<void>;
  };
  // invariant: karma producer call site. Proposal review uses the in-transaction
  // variant so resolution and karma cannot half-commit. see also: DynamicsService.
  readonly dynamicsService?: Pick<
    DynamicsService,
    "emitKarmaEvent" | "emitKarmaEventInCurrentTransaction"
  >;
  // Evidence resolver used by soul.open_pointer to dereference
  // evidence_refs[] from a MemoryEntry back to its raw EvidenceCapsule
  // (gist / excerpt). Scoped lookup mirrors memoryService.findByIdScoped.
  readonly evidenceService?: {
    findByIdScoped?(
      objectId: string,
      workspaceId: string
    ): Promise<Readonly<{
      readonly object_id: string;
      readonly object_kind: string;
      readonly schema_version: number;
      readonly gist: string | null;
      readonly excerpt: string | null;
    }> | null>;
  };
  // PathRelation propose hook. When report_context_usage produces
  // RECALLS edges between used memories, the service tracks co-usage
  // counts; on the Nth co-usage of a pair, it writes a new PathRelation
  // entry so PathPlasticityService has a relation to evolve.
  readonly pathRelationProposalService?: {
    onCoUsage(
      usedObjectIds: readonly string[],
      workspaceId: string
    ): Promise<void>;
    // invariant: co-recall plasticity primitive. Called fire-and-forget at
    // recall delivery with the delivered top-K ids. `allowedPairKeys` carries
    // the semantic-coherence gate (canonical `${low}|${high}` pair keys) so
    // only related endpoints strengthen a path; an absent gate accrues every
    // pair. see also: path-relation-proposal-service.ts onCoRecall.
    onCoRecall(
      recalledObjectIds: readonly string[],
      workspaceId: string,
      allowedPairKeys?: ReadonlySet<string>
    ): Promise<void>;
  };
  // invariant: embedding coherence is checked outside the truth-boundary path
  // service; this gate returns only canonical `${low}|${high}` delivered-pair keys.
  // see also:
  // apps/core-daemon/src/ai/daemon-embedding-runtime.ts:createDaemonEmbeddingRuntime,
  // packages/core/src/embedding-recall/service.ts:EmbeddingRecallService.coherentPairKeys.
  readonly coRecallCoherenceGate?: {
    coherentPairKeys(
      workspaceId: string,
      deliveredObjectIds: readonly string[]
    ): Promise<ReadonlySet<string>>;
  };
  readonly signalService: {
    receiveSignal(signal: CandidateMemorySignal): Promise<Readonly<{
      readonly signal: Readonly<CandidateMemorySignal>;
    }>>;
  };
  readonly graphExploreService: {
    exploreOneHop(
      memoryId: string,
      workspaceId: string,
      options?: Readonly<{
        readonly edgeTypes?: readonly string[];
        readonly direction?: "inbound" | "outbound" | "both";
        readonly runId?: string | null;
      }>
    ): Promise<readonly Readonly<{ readonly memory_id: string; readonly edge_type: string; readonly direction: string; readonly edge_id: string }>[]>;
  };
  readonly edgeProposalService?: {
    proposeExplicitEdge(input: {
      readonly sourceMemoryId: string;
      readonly targetMemoryId: string;
      readonly edgeType: MemoryGraphEdgeTypeValue;
      readonly confidence: number;
      readonly reason: string | null;
      readonly workspaceId: string;
      readonly runId: string | null;
    }): Promise<Readonly<{ readonly proposal_id: string; readonly status: string }>>;
    listPending(
      workspaceId: string,
      filter?: SoulListPendingEdgeProposalsRequest
    ): ReturnType<typeof SoulListPendingEdgeProposalsResponseSchema.parse>;
    batchReview(input: {
      readonly workspaceId: string;
      readonly verdict: "accept" | "reject";
      readonly filter: SoulBatchReviewEdgeProposalsRequest["filter"];
      readonly reason: string | null;
      readonly reviewerIdentity: string;
    }): Promise<ReturnType<typeof SoulBatchReviewEdgeProposalsResponseSchema.parse>>;
  };
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
  // Optional write port for RECALLS-edge cross-linking on used reports.
  // Single canonical declaration lives next to MaterializationRouter — re-using
  // the same port keeps the daemon-side wiring and the materializer in lockstep.
  readonly graphEdgePort?: GraphEdgeCreationPort;
  readonly sessionOverrideService: {
    apply(params: {
      readonly runId: string;
      readonly workspaceId: string;
      readonly targetObject: string;
      readonly correction: string;
      readonly priority?: number;
    }): Promise<Readonly<{ readonly runtime_id: string }>>;
  };
  readonly trustStateRecorder: {
    recordDelivery(input: Omit<ContextDeliveryRecord, "audit_event_id">): Promise<ContextDeliveryRecord>;
    recordUsage(
      input: Omit<UsageProofRecord, "audit_event_id">,
      options?: { readonly expectedWorkspaceId?: string }
    ): Promise<UsageProofRecord>;
    findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
  };
  readonly eventPublisher?: {
    appendManyWithMutation<T>(
      inputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T>;
  };
  readonly asyncSideEffectAudit?: RecallUsageHandlerDependencies["asyncSideEffectAudit"];
  readonly memoryEntryRepo?: {
    updateTier(input: {
      readonly objectId: string;
      readonly workspaceId: string;
      readonly fromTier: StorageTier;
      readonly toTier: StorageTier;
      readonly updatedAt: string;
      readonly expectedUpdatedAt: string;
      readonly activationBump?: number;
      readonly lastUsedAt?: string;
      readonly lastHitAt?: string;
    }): Readonly<MemoryEntry> | null;
  };
  readonly proposalWorkflow?: {
    proposeMemoryUpdate(
      input: SoulProposeMemoryUpdateRequest,
      context: McpMemoryToolCallContext
    ): Promise<Readonly<{ readonly proposal_id: string; readonly status: "created" | "rejected" }>>;
    reviewMemoryProposal(
      input: SoulReviewMemoryProposalRequest,
      context: McpMemoryToolCallContext
    ): Promise<Readonly<{ readonly proposal_id: string; readonly resolution_state: Proposal["resolution_state"] }>>;
    // Projects the workspace-scoped pending queue. The handler enforces
    // workspace via the trusted MCP call context; the request payload's
    // workspace_id is rejected if it does not match (SECURITY: invariants
    // §29 Default Scope).
    listPendingProposals(
      input: SoulListPendingProposalsRequest,
      context: McpMemoryToolCallContext
    ): Promise<Readonly<{
      readonly proposals: readonly Readonly<SoulPendingProposalSummary>[];
      readonly total_count: number;
    }>>;
  };
  readonly gardenTaskRepo?: {
    enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
    findById(taskId: string): GardenTaskRow | null;
    peekPending(
      role: GardenRoleValue,
      workspace_id?: string,
      limit?: number
    ): readonly GardenTaskRow[];
    claimAtomic(
      taskId: string,
      claimedBy: string,
      claimedAt: string,
      workspace_id?: string
    ): Promise<"claimed" | "already-claimed">;
    completeWithEvents(
      taskId: string,
      result: GardenTaskCompletionResult,
      events: readonly GardenTaskEventInput[],
      claimedBy: string
    ): Promise<void>;
    beginCompletionAttempt(
      taskId: string,
      claimedBy: string,
      completionClaimedBy: string,
      claimedAt: string,
      completionEnvelopeJson?: string | null
    ): boolean;
    refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean;
    releaseClaim(taskId: string, claimedBy: string): Promise<boolean>;
    // invariant: per-kind eventual-consistency diagnostic source. pending =
    // unclaimed; stale = claimed past the cutoff. Optional so a fake repo in a
    // test need not implement it; the EDGE_CLASSIFY completion only emits the
    // diagnostic when present. see also: garden-task-repo.ts countByKind.
    countByKind?(
      kind: string,
      staleBeforeIso: string,
      workspace_id?: string
    ): { readonly kind: string; readonly pending: number; readonly stale: number };
  };
  // invariant: applies a host-worker EDGE_CLASSIFY verdict to the existing
  // heuristic path. Wired to EdgeAutoProducerService.applyVerdict. A "none" /
  // below-floor verdict refines nothing; the inline heuristic edge always
  // stands. When unwired, an EDGE_CLASSIFY completion that carries an
  // edge_verdict is rejected (the queue should not have been enabled).
  // see also: packages/core/src/path-graph/edge-auto-producer-service.ts applyVerdict.
  readonly edgeVerdictApplier?: {
    applyVerdict(input: {
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly sourceSignalId: string | null;
      readonly verdict: EdgeClassifyVerdict;
    }): Promise<string | null>;
  };
  // invariant: surface_identities row is the canonical record that a
  // given agent_target has ever attached to this workspace. The handler
  // calls ensureAgentSurface once per (workspace_id, agent_target) per
  // process so the first MCP tool call from each attached agent
  // (codex / claude-code / mcp) lands one durable surface_identity row;
  // subsequent calls become idempotent in-memory hits.
  // see also: packages/core/src/surfaces/surface-service.ts SurfaceService.createSurface
  readonly attachSurfaceRegistrar?: {
    ensureAgentSurface(input: {
      readonly workspaceId: string;
      readonly agentTarget: string;
    }): Promise<void>;
  };
  // see also: apps/core-daemon/src/mcp-memory/resolve-handler.ts
  //   createSoulResolveHandler
  readonly soulResolveHandler?: SoulResolveHandler;
  readonly now?: () => string;
  readonly generateId?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export type McpMemoryToolCallResult =
  | Readonly<{
      readonly ok: true;
      readonly tool_name: AlayaMemoryToolName;
      readonly output: unknown;
    }>
  | Readonly<{
      readonly ok: false;
      readonly tool_name: string;
      readonly error: Readonly<{
        readonly code: "UNKNOWN_TOOL" | "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "NEEDS_CONTEXT" | "INTERNAL";
        readonly message: string;
      }>;
    }>;

export type McpMemoryToolErrorCode = Extract<McpMemoryToolCallResult, { ok: false }>["error"]["code"];

export interface McpMemoryToolHandler {
  call(input: {
    readonly toolName: string;
    readonly arguments: unknown;
    readonly context: McpMemoryToolCallContext;
  }): Promise<McpMemoryToolCallResult>;
}
