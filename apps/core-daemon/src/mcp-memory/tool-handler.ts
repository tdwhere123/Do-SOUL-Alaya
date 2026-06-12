import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  CandidateMemorySignalMemoryRefKeys,
  ControlPlaneObjectKind,
  EdgeProposalTriggerSource,
  GardenClaimTaskRequestSchema,
  GardenClaimTaskResponseSchema,
  GardenCompleteTaskRequestSchema,
  GardenCompleteTaskResponseSchema,
  GardenListPendingTasksRequestSchema,
  GardenListPendingTasksResponseSchema,
  MemoryGovernanceEventType,
  MemoryGraphEdgeType,
  MemoryDimensionSchema,
  ProposalResolutionState,
  RecallContextEventType,
  RetentionPolicy,
  ScopeClassSchema,
  SignalSource,
  SoulApplyOverrideRequestSchema,
  SoulBatchReviewEdgeProposalsRequestSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulApplyOverrideResponseSchema,
  SoulContextUsageReportedPayloadSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulEmitCandidateSignalResponseSchema,
  SoulExploreGraphRequestSchema,
  SoulExploreGraphResponseSchema,
  SoulListPendingEdgeProposalsRequestSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulListPendingProposalsRequestSchema,
  SoulListPendingProposalsResponseSchema,
  SoulMemorySearchRequestSchema,
  SoulMemorySearchResponseSchema,
  SoulOpenPointerRequestSchema,
  SoulOpenPointerResponseSchema,
  SoulProposeEdgeRequestSchema,
  SoulProposeEdgeResponseSchema,
  SoulMemoryTierPromotedPayloadSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulProposeMemoryUpdateResponseSchema,
  SoulRecallDeliveredPayloadSchema,
  SoulReportContextUsageRequestSchema,
  SoulReportContextUsageResponseSchema,
  SoulReviewMemoryProposalRequestSchema,
  SoulReviewMemoryProposalResponseSchema,
  StorageTier,
  TaskObjectSurfaceSchema,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type EdgeClassifyVerdict,
  type EventLogEntry,
  type GardenRoleValue,
  type MemoryEntry,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type MemoryGraphEdgeTypeValue,
  type SoulApplyOverrideRequest,
  type SoulActiveConstraint,
  type SoulBatchReviewEdgeProposalsRequest,
  type SoulEmitCandidateSignalRequest,
  type SoulExploreGraphRequest,
  type SoulListPendingEdgeProposalsRequest,
  type SoulListPendingProposalsRequest,
  type SoulPendingProposalSummary,
  type SoulMemorySearchRequest,
  type SoulOpenPointerRequest,
  type SoulProposeEdgeRequest,
  type SoulProposeMemoryUpdateRequest,
  type SoulRecallHostContext,
  type SoulMemorySearchDegradationReason,
  type SoulReportContextUsageRequest,
  type SoulReviewMemoryProposalRequest,
  type MemoryEntryMutableFields,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskCompletionResult,
  GardenTaskEnqueueInput,
  GardenTaskEventInput,
  GardenTaskRow
} from "@do-soul/alaya-storage";
import { normalizeSchemaGroundedSignal, type GraphEdgeCreationPort } from "@do-soul/alaya-soul";
import { hasAlayaMemoryToolName, type AlayaMemoryToolName } from "./tool-catalog.js";
import { buildMemorySearchResult, buildRecallStrategyMix } from "./recall-result.js";
import { createGardenTaskHandlers } from "./garden-task-handlers.js";
import {
  createRecallHandler,
  createReportContextUsageHandler
} from "./recall-usage-handlers.js";
import type { createSoulResolveHandler } from "./resolve-handler.js";
import type { ReviewerIdentityBinding } from "./proposal-workflow.js";

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
  // invariant: reuse_gain producer call site. see also:
  // DynamicsService.emitKarmaEvent.
  readonly dynamicsService?: {
    emitKarmaEvent(input: {
      readonly kind: "reuse_gain";
      readonly objectId: string;
      readonly workspaceId: string;
      readonly runId?: string | null;
    }): Promise<void>;
  };
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
    ): "claimed" | "already-claimed";
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
    releaseClaim(taskId: string, claimedBy: string): boolean;
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

type McpMemoryToolErrorCode = Extract<McpMemoryToolCallResult, { ok: false }>["error"]["code"];

export interface McpMemoryToolHandler {
  call(input: {
    readonly toolName: string;
    readonly arguments: unknown;
    readonly context: McpMemoryToolCallContext;
  }): Promise<McpMemoryToolCallResult>;
}

export function createMcpMemoryToolHandler(deps: McpMemoryToolHandlerDependencies): McpMemoryToolHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const generateId = deps.generateId ?? randomUUID;
  const warn = deps.warn ?? ((message: string, meta: Record<string, unknown>) => console.warn(message, meta));
  const gardenTasks = createGardenTaskHandlers({ deps, now, warn, generateId });
  const recall = createRecallHandler({ deps, now, warn, generateId });
  const reportContextUsage = createReportContextUsageHandler({ deps, now, warn });
  const registeredSurfaces = new Set<string>();

  async function ensureAgentSurfaceForCall(context: McpMemoryToolCallContext): Promise<void> {
    const registrar = deps.attachSurfaceRegistrar;
    if (registrar === undefined) return;
    const workspaceId = context.workspaceId;
    const agentTarget = context.agentTarget;
    if (workspaceId.length === 0 || agentTarget.length === 0) return;
    const key = JSON.stringify([workspaceId, agentTarget]);
    if (registeredSurfaces.has(key)) return;
    registeredSurfaces.add(key);
    try {
      await registrar.ensureAgentSurface({ workspaceId, agentTarget });
    } catch (error) {
      registeredSurfaces.delete(key);
      warn("agent surface registration failed", {
        workspace_id: workspaceId,
        agent_target: agentTarget,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    async call({ toolName, arguments: rawArguments, context }) {
      if (!hasAlayaMemoryToolName(toolName)) {
        return fail(toolName, "UNKNOWN_TOOL", `Unsupported Alaya memory tool: ${toolName}`);
      }
      await ensureAgentSurfaceForCall(context);

      try {
        switch (toolName) {
          case "soul.recall":
            return ok(toolName, await recall(SoulMemorySearchRequestSchema.parse(rawArguments), context));
          case "soul.open_pointer":
            return ok(toolName, await openPointer(SoulOpenPointerRequestSchema.parse(rawArguments), context));
          case "soul.emit_candidate_signal":
            return ok(toolName, await emitCandidateSignal(SoulEmitCandidateSignalRequestSchema.parse(rawArguments), context));
          case "soul.propose_memory_update":
            return ok(toolName, await proposeMemoryUpdate(SoulProposeMemoryUpdateRequestSchema.parse(rawArguments), context));
          case "soul.review_memory_proposal":
            return ok(toolName, await reviewMemoryProposal(SoulReviewMemoryProposalRequestSchema.parse(rawArguments), context));
          case "soul.list_pending_proposals":
            return ok(toolName, await listPendingProposals(SoulListPendingProposalsRequestSchema.parse(rawArguments), context));
          case "soul.propose_edge":
            return ok(toolName, await proposeEdge(SoulProposeEdgeRequestSchema.parse(rawArguments), context));
          case "soul.list_pending_edge_proposals":
            return ok(toolName, await listPendingEdgeProposals(SoulListPendingEdgeProposalsRequestSchema.parse(rawArguments), context));
          case "soul.batch_review_edge_proposals":
            return ok(toolName, await batchReviewEdgeProposals(SoulBatchReviewEdgeProposalsRequestSchema.parse(rawArguments), context));
          case "soul.apply_override":
            return ok(toolName, await applyOverride(SoulApplyOverrideRequestSchema.parse(rawArguments), context));
          case "soul.explore_graph":
            return ok(toolName, await exploreGraph(SoulExploreGraphRequestSchema.parse(rawArguments), context));
          case "soul.report_context_usage":
            return ok(toolName, await reportContextUsage(SoulReportContextUsageRequestSchema.parse(rawArguments), context));
          case "soul.resolve":
            return ok(toolName, await resolveStagedWarning(rawArguments, context));
          case "garden.list_pending_tasks":
            return ok(
              toolName,
              GardenListPendingTasksResponseSchema.parse(
                await gardenTasks.listPendingGardenTasks(
                  GardenListPendingTasksRequestSchema.parse(rawArguments),
                  context
                )
              )
            );
          case "garden.claim_task":
            return ok(
              toolName,
              GardenClaimTaskResponseSchema.parse(
                await gardenTasks.claimGardenTask(
                  GardenClaimTaskRequestSchema.parse(rawArguments),
                  context
                )
              )
            );
          case "garden.complete_task":
            return ok(
              toolName,
              GardenCompleteTaskResponseSchema.parse(
                await gardenTasks.completeGardenTask(
                  GardenCompleteTaskRequestSchema.parse(rawArguments),
                  context
                )
              )
            );
        }
      } catch (error) {
        return fail(toolName, classifyError(error), sanitizeError(error));
      }
    }
  };

  async function openPointer(request: SoulOpenPointerRequest, context: McpMemoryToolCallContext) {
    // SECURITY (invariants §30 Fix at Source): scoped lookup blocks
    // cross-workspace pointer resolution at the service layer. Memory
    // lookup is the primary path; if it misses, fall through to
    // EvidenceCapsule lookup so attached agents can resolve evidence_refs
    // to the raw turn material that backs a distilled MemoryEntry.
    const memory = await deps.memoryService.findByIdScoped(
      request.object_id,
      context.workspaceId
    );
    if (memory !== null) {
      return SoulOpenPointerResponseSchema.parse({
        object_id: memory.object_id,
        object_kind: memory.object_kind,
        content: {
          object_id: memory.object_id,
          object_kind: memory.object_kind,
          schema_version: memory.schema_version,
          content: memory.content ?? null,
          domain_tags: memory.domain_tags ?? [],
          evidence_refs: memory.evidence_refs ?? []
        }
      });
    }

    if (deps.evidenceService?.findByIdScoped !== undefined) {
      const evidence = await deps.evidenceService.findByIdScoped(
        request.object_id,
        context.workspaceId
      );
      if (evidence !== null) {
        return SoulOpenPointerResponseSchema.parse({
          object_id: evidence.object_id,
          object_kind: evidence.object_kind,
          content: {
            object_id: evidence.object_id,
            object_kind: evidence.object_kind,
            schema_version: evidence.schema_version,
            content: evidence.excerpt ?? evidence.gist ?? null,
            domain_tags: [],
            evidence_refs: [],
            gist: evidence.gist,
            excerpt: evidence.excerpt
          }
        });
      }
    }

    throw new ToolNotFoundError(`Pointer object not found: ${request.object_id}`);
  }

  async function emitCandidateSignal(
    request: SoulEmitCandidateSignalRequest,
    context: McpMemoryToolCallContext
  ) {
    // SECURITY (invariants §29 Default Scope): workspace_id / run_id /
    // surface_id are NOT in the public MCP request schema (see
    // SoulEmitCandidateSignalRequestSchema / McpEmitCandidateSignalRequestSchema).
    // The daemon binds them from the trusted MCP call context. The attached
    // agent cannot redirect signals to a foreign workspace because the schema
    // rejects the fields outright before this function runs.
    if (context.runId === null) {
      throw new ToolValidationError(
        "soul.emit_candidate_signal requires a runId in the MCP call context."
      );
    }
    await validateSourceDeliveryAnchors(request.source_delivery_ids, context);
    const signal = CandidateMemorySignalSchema.parse({
      signal_id: `signal_${generateId()}`,
      ...normalizeCandidateSignalGraphRefs(request, warn),
      workspace_id: context.workspaceId,
      run_id: context.runId,
      surface_id: context.surfaceId ?? null,
      source: SignalSource.MODEL_TOOL,
      created_at: now()
    });
    warnIfModelToolSignalMissingDeliveryAnchor(signal);
    const received = await deps.signalService.receiveSignal(signal);
    return SoulEmitCandidateSignalResponseSchema.parse({
      signal_id: received.signal.signal_id,
      status: "emitted"
    });
  }

  async function proposeMemoryUpdate(
    request: SoulProposeMemoryUpdateRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.proposalWorkflow === undefined) {
      throw new ToolUnavailableError("Memory proposal workflow is not available.");
    }
    await validateSourceDeliveryAnchors(request.source_delivery_ids, context);
    return SoulProposeMemoryUpdateResponseSchema.parse(
      await deps.proposalWorkflow.proposeMemoryUpdate(request, context)
    );
  }

  async function reviewMemoryProposal(
    request: SoulReviewMemoryProposalRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.proposalWorkflow === undefined) {
      throw new ToolUnavailableError("Memory proposal workflow is not available.");
    }
    const reviewed = await deps.proposalWorkflow.reviewMemoryProposal(request, context);
    return SoulReviewMemoryProposalResponseSchema.parse({
      proposal_id: reviewed.proposal_id,
      resolution_state:
        request.verdict === "accept" && reviewed.resolution_state === ProposalResolutionState.PENDING
          ? ProposalResolutionState.ACCEPTED
          : reviewed.resolution_state
    });
  }

  async function listPendingProposals(
    request: SoulListPendingProposalsRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.proposalWorkflow === undefined) {
      throw new ToolUnavailableError("Memory proposal workflow is not available.");
    }
    // invariant: workspace identity comes from the trusted MCP context,
    // not public proposal-list input.
    const result = await deps.proposalWorkflow.listPendingProposals(request, context);
    return SoulListPendingProposalsResponseSchema.parse({
      proposals: result.proposals,
      total_count: result.total_count
    });
  }

  async function proposeEdge(
    request: SoulProposeEdgeRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.edgeProposalService === undefined) {
      throw new ToolUnavailableError("Edge proposal service is not available.");
    }
    return SoulProposeEdgeResponseSchema.parse(
      await deps.edgeProposalService.proposeExplicitEdge({
        sourceMemoryId: request.source_memory_id,
        targetMemoryId: request.target_memory_id,
        edgeType: request.edge_type,
        confidence: Math.min(request.confidence, 0.5),
        reason: request.reason ?? null,
        workspaceId: context.workspaceId,
        runId: context.runId
      })
    );
  }

  async function listPendingEdgeProposals(
    request: SoulListPendingEdgeProposalsRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.edgeProposalService === undefined) {
      throw new ToolUnavailableError("Edge proposal service is not available.");
    }
    return SoulListPendingEdgeProposalsResponseSchema.parse(
      deps.edgeProposalService.listPending(context.workspaceId, request)
    );
  }

  async function batchReviewEdgeProposals(
    request: SoulBatchReviewEdgeProposalsRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.edgeProposalService === undefined) {
      throw new ToolUnavailableError("Edge proposal service is not available.");
    }
    assertEdgeReviewCallerIsAllowed(context, deps.reviewerIdentityBinding);
    const reviewerIdentity = resolveEdgeReviewerIdentity(request, deps.reviewerIdentityBinding);
    return SoulBatchReviewEdgeProposalsResponseSchema.parse(
      await deps.edgeProposalService.batchReview({
        workspaceId: context.workspaceId,
        verdict: request.verdict,
        filter: request.filter,
        reason: request.reason,
        reviewerIdentity
      })
    );
  }

  function warnIfModelToolSignalMissingDeliveryAnchor(signal: CandidateMemorySignal): void {
    if (
      signal.source === SignalSource.MODEL_TOOL &&
      (signal.source_delivery_ids === undefined || signal.source_delivery_ids.length === 0)
    ) {
      warn("MODEL_TOOL candidate signal emitted without source_delivery_ids.", {
        signal_id: signal.signal_id,
        source: signal.source
      });
    }
  }

  async function validateSourceDeliveryAnchors(
    sourceDeliveryIds: readonly string[] | undefined,
    context: McpMemoryToolCallContext
  ): Promise<void> {
    if (sourceDeliveryIds === undefined) {
      return;
    }

    for (const deliveryId of sourceDeliveryIds) {
      const delivery = await deps.trustStateRecorder.findDeliveryById(deliveryId);
      if (!isSourceDeliveryInScope(delivery, context)) {
        throw new ToolValidationError(
          `source_delivery_ids contains an unknown or out-of-scope delivery_id: ${deliveryId}`
        );
      }
    }
  }

  function isSourceDeliveryInScope(
    delivery: Readonly<ContextDeliveryRecord> | null,
    context: McpMemoryToolCallContext
  ): delivery is Readonly<ContextDeliveryRecord> {
    if (delivery === null) {
      return false;
    }

    return delivery.agent_target === context.agentTarget &&
      delivery.workspace_id === context.workspaceId &&
      delivery.run_id === context.runId;
  }

  async function applyOverride(
    request: SoulApplyOverrideRequest,
    context: McpMemoryToolCallContext
  ) {
    if (context.runId === null) {
      throw new ToolValidationError("soul.apply_override requires a run context.");
    }
    const applied = await deps.sessionOverrideService.apply({
      runId: context.runId,
      workspaceId: context.workspaceId,
      targetObject: request.target_object,
      correction: request.correction,
      ...(request.priority === undefined ? {} : { priority: request.priority })
    });
    return SoulApplyOverrideResponseSchema.parse({
      override_id: applied.runtime_id,
      status: "applied"
    });
  }

  async function resolveStagedWarning(
    rawArguments: unknown,
    context: McpMemoryToolCallContext
  ) {
    const handler = deps.soulResolveHandler;
    if (handler === undefined) {
      // invariant: surface UNAVAILABLE distinctly so MCP clients
      // can detect mis-wired daemons.
      throw new ToolUnavailableError(
        "soul.resolve is not wired into this daemon"
      );
    }
    // SECURITY (invariants §29 Default Scope): the resolve handler
    // re-binds workspace_id / run_id / agent_target from the trusted
    // MCP call context and re-verifies the delivery scope.
    return await handler.resolve(rawArguments, {
      workspaceId: context.workspaceId,
      runId: context.runId,
      agentTarget: context.agentTarget
    });
  }

  async function exploreGraph(
    request: SoulExploreGraphRequest,
    context: McpMemoryToolCallContext
  ) {
    // SECURITY (invariants §29 Default Scope): workspace is server-bound from
    // the trusted MCP call context; payload cannot redirect graph exploration
    // to a foreign workspace.
    const neighbors = await deps.graphExploreService.exploreOneHop(
      request.memory_id,
      context.workspaceId,
      {
        ...(request.edge_types === undefined ? {} : { edgeTypes: request.edge_types }),
        ...(request.direction === undefined ? {} : { direction: request.direction }),
        runId: context.runId
      }
    );
    return SoulExploreGraphResponseSchema.parse({
      source_memory_id: request.memory_id,
      neighbors,
      count: neighbors.length
    });
  }

}

function ok(toolName: AlayaMemoryToolName, output: unknown): McpMemoryToolCallResult {
  return Object.freeze({ ok: true, tool_name: toolName, output });
}

function fail(
  toolName: string,
  code: McpMemoryToolErrorCode,
  message: string
): McpMemoryToolCallResult {
  return Object.freeze({
    ok: false,
    tool_name: toolName,
    error: Object.freeze({ code, message })
  });
}

const HUMAN_REVIEWER_AGENT_TARGETS: ReadonlySet<string> = new Set([
  "inspector",
  "cli"
]);

function assertEdgeReviewCallerIsAllowed(
  context: McpMemoryToolCallContext,
  binding: ReviewerIdentityBinding | undefined
): void {
  if (binding !== undefined || HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget)) {
    return;
  }

  throw new ToolValidationError(
    "Review requires a human reviewer surface (Inspector/alaya review) or a configured reviewer token."
  );
}

function resolveEdgeReviewerIdentity(
  request: SoulBatchReviewEdgeProposalsRequest,
  binding: ReviewerIdentityBinding | undefined
): string {
  if (binding === undefined) {
    return request.reviewer_identity;
  }

  if (!matchesReviewerToken(request.reviewer_token, binding.token)) {
    throw new ToolValidationError("Invalid reviewer token.");
  }
  if (request.reviewer_identity !== binding.identity) {
    throw new ToolValidationError("Reviewer identity does not match server-bound reviewer.");
  }
  return binding.identity;
}

function matchesReviewerToken(providedToken: string | undefined, expectedToken: string): boolean {
  if (providedToken === undefined || providedToken.length === 0) {
    return false;
  }
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

type CandidateSignalGraphRefKey = (typeof CandidateMemorySignalMemoryRefKeys)[number];
type CandidateSignalGraphRefInput = {
  readonly raw_payload: Readonly<Record<string, unknown>>;
} & Partial<Record<CandidateSignalGraphRefKey, readonly string[]>>;

// invariant: graph-edge ref hints (`source_memory_refs`,
// `supersedes_refs`, `exception_to_refs`, `contradicts_refs`,
// `incompatible_with_refs`) are first-class fields on
// `CandidateMemorySignal` (see
// `packages/protocol/src/signals/candidate-memory-signal.ts`
// CandidateMemorySignalMemoryRefKeys). The daemon does not accept
// these keys via `raw_payload`; any occurrence is logged and left in
// raw_payload unchanged. Closes the "silent double-entry" path —
// agents that want to assert graph hints MUST use the first-class
// fields, not the untyped raw_payload channel.
function normalizeCandidateSignalGraphRefs<T extends CandidateSignalGraphRefInput>(
  input: T,
  warn: (message: string, meta: Record<string, unknown>) => void
): T {
  const offendingKeys: CandidateSignalGraphRefKey[] = [];
  for (const key of CandidateMemorySignalMemoryRefKeys) {
    if (hasOwnProperty(input.raw_payload, key)) {
      offendingKeys.push(key);
    }
  }
  if (offendingKeys.length > 0) {
    warn(
      "candidate signal raw_payload contains graph-edge ref keys; use first-class fields instead. Ignoring raw_payload entries.",
      {
        offending_keys: offendingKeys
      }
    );
  }
  return input;
}

function hasOwnProperty(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

class ToolValidationError extends Error {
  public readonly code = "VALIDATION";
}

class ToolUnavailableError extends Error {
  public readonly code = "UNAVAILABLE";
}

class ToolNotFoundError extends Error {
  public readonly code = "NOT_FOUND";
}

class RecallHitTierPromotionCasMiss extends Error {
  public constructor() {
    super("Recall-hit tier promotion CAS predicate did not match.");
    this.name = "RecallHitTierPromotionCasMiss";
  }
}

function classifyError(error: unknown): "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "NEEDS_CONTEXT" | "INTERNAL" {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "VALIDATION" ||
      error.code === "UNAVAILABLE" ||
      error.code === "NOT_FOUND" ||
      error.code === "NEEDS_CONTEXT")
  ) {
    return error.code;
  }
  if (
    error instanceof ToolValidationError ||
    (error instanceof Error && "name" in error && error.name === "ZodError")
  ) {
    return "VALIDATION";
  }
  if (error instanceof ToolUnavailableError) {
    return "UNAVAILABLE";
  }
  if (error instanceof ToolNotFoundError) {
    return "NOT_FOUND";
  }
  return "INTERNAL";
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "MCP memory tool call failed.";
}
