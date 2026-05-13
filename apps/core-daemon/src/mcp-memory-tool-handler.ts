import { createHash, randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  ControlPlaneObjectKind,
  GARDEN_ROLE_TIER_MAP,
  GardenClaimTaskRequestSchema,
  GardenClaimTaskResponseSchema,
  GardenCompleteTaskRequestSchema,
  GardenCompleteTaskResponseSchema,
  GardenEventType,
  GardenListPendingTasksRequestSchema,
  GardenListPendingTasksResponseSchema,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  MemoryGovernanceEventType,
  MemoryDimensionSchema,
  parseGardenEventPayload,
  ProposalResolutionState,
  RecallContextEventType,
  RetentionPolicy,
  ScopeClassSchema,
  SignalSource,
  SoulApplyOverrideRequestSchema,
  SoulApplyOverrideResponseSchema,
  SoulContextUsageReportedPayloadSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulEmitCandidateSignalResponseSchema,
  SoulExploreGraphRequestSchema,
  SoulExploreGraphResponseSchema,
  SoulListPendingProposalsRequestSchema,
  SoulListPendingProposalsResponseSchema,
  SoulMemorySearchRequestSchema,
  SoulMemorySearchResponseSchema,
  SoulOpenPointerRequestSchema,
  SoulOpenPointerResponseSchema,
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
  type EventLogEntry,
  type GardenClaimTaskRequest,
  type GardenCompleteTaskRequest,
  type GardenListPendingTasksRequest,
  type GardenMcpWorkerRole,
  type GardenRoleValue,
  type MemoryEntry,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type SoulApplyOverrideRequest,
  type SoulEmitCandidateSignalRequest,
  type SoulExploreGraphRequest,
  type SoulListPendingProposalsRequest,
  type SoulPendingProposalSummary,
  type SoulMemorySearchRequest,
  type SoulOpenPointerRequest,
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
import { stableStringify } from "@do-soul/alaya-core";
import { normalizeSchemaGroundedSignal } from "@do-soul/alaya-soul";
import { buildGardenTaskSignalId } from "./garden-task-signal-id.js";
import { hasAlayaMemoryToolName, type AlayaMemoryToolName } from "./mcp-memory-tool-catalog.js";
import { buildMemorySearchResult, buildRecallStrategyMix } from "./mcp-memory-recall-result.js";

type MemoryUsageRefreshFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};
type GardenCompletionCandidateSignal = NonNullable<
  NonNullable<GardenCompleteTaskRequest["result_envelope"]>["candidate_signals"]
>[number];

const RECALL_HIT_ACTIVATION_BUMP = 0.05;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;
// Auto-extract from a recall turn only when there is enough text for the
// Garden compute provider to find a durable signal in; a bare keyword query
// is below this floor and not worth a Garden task.
const MIN_AUTO_EXTRACT_TURN_CHARS = 24;
// Stop enqueuing recall-driven extract tasks once the pending Garden queue
// visible to peekPending(LIBRARIAN, ...) — librarian rows plus the
// higher-priority janitor/auditor rows — for a workspace is this deep: Garden
// is not draining (e.g. host_worker mode with no worker, or a stalled
// background pass) and piling on cannot help. Coarse backpressure —
// over-counting only makes Alaya more conservative.
const RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD = 128;

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
    }): Promise<Readonly<{
      readonly candidates: readonly Readonly<RecallCandidate>[];
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
  };
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

  return {
    async call({ toolName, arguments: rawArguments, context }) {
      if (!hasAlayaMemoryToolName(toolName)) {
        return fail(toolName, "UNKNOWN_TOOL", `Unsupported Alaya memory tool: ${toolName}`);
      }

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
          case "soul.apply_override":
            return ok(toolName, await applyOverride(SoulApplyOverrideRequestSchema.parse(rawArguments), context));
          case "soul.explore_graph":
            return ok(toolName, await exploreGraph(SoulExploreGraphRequestSchema.parse(rawArguments), context));
          case "soul.report_context_usage":
            return ok(toolName, await reportContextUsage(SoulReportContextUsageRequestSchema.parse(rawArguments), context));
          case "garden.list_pending_tasks":
            return ok(toolName, await listPendingGardenTasks(GardenListPendingTasksRequestSchema.parse(rawArguments), context));
          case "garden.claim_task":
            return ok(toolName, await claimGardenTask(GardenClaimTaskRequestSchema.parse(rawArguments), context));
          case "garden.complete_task":
            return ok(toolName, await completeGardenTask(GardenCompleteTaskRequestSchema.parse(rawArguments), context));
        }
      } catch (error) {
        return fail(toolName, classifyError(error), sanitizeError(error));
      }
    }
  };

  async function recall(
    request: SoulMemorySearchRequest,
    context: McpMemoryToolCallContext
  ) {
    const recallStartedAt = Date.now();
    const taskSurface = TaskObjectSurfaceSchema.parse({
      runtime_id: generateId(),
      object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      task_surface_ref: null,
      expires_at: null,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      surface_kind: "mcp_memory_tool",
      display_name: request.query,
      context_refs: []
    });
    const policyOverride = buildRecallPolicy(request, taskSurface.runtime_id, generateId());
    const timeFilter =
      request.since !== undefined || request.until !== undefined || request.time_field !== undefined
        ? {
            since: request.since ?? null,
            until: request.until ?? null,
            field: request.time_field ?? "created_at"
          }
        : undefined;
    const recallResult = await deps.recallService.recall({
      taskSurface,
      workspaceId: context.workspaceId,
      strategy: "chat",
      runId: context.runId,
      policyOverride,
      timeFilter,
      hostContext: request.host_context
    });
    let usedTokens = 0;
    let explainabilityPartial = false;
    const results = recallResult.candidates.slice(0, request.max_results).map((candidate, index) => {
      if (
        candidate.selection_reason === undefined ||
        candidate.source_channels === undefined ||
        candidate.score_factors === undefined ||
        candidate.budget_state === undefined
      ) {
        explainabilityPartial = true;
      }
      const result = buildMemorySearchResult(candidate, policyOverride, index, usedTokens);
      usedTokens += candidate.token_estimate;
      return result;
    });
    const deliveryId = `delivery_${generateId()}`;
    const deliveredObjectIds = results.map((result) => result.object_id);
    await deps.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: deliveredObjectIds,
      delivered_at: now()
    });

    enqueueRecallExtractTask(request, context, deliveredObjectIds);

    await emitRecallDeliveredTelemetry({
      deliveryId,
      query: request.query,
      pointerCount: results.length,
      latencyMs: Date.now() - recallStartedAt,
      context
    });

    const degradationReason =
      recallResult.degradation_reason ?? (explainabilityPartial ? "recall_explainability_partial" : null);

    return SoulMemorySearchResponseSchema.parse({
      delivery_id: deliveryId,
      results,
      total_count: recallResult.fine_assessment_count,
      strategy_mix: buildRecallStrategyMix(policyOverride, results),
      degradation_reason: degradationReason
    });
  }

  async function emitRecallDeliveredTelemetry(input: {
    readonly deliveryId: string;
    readonly query: string;
    readonly pointerCount: number;
    readonly latencyMs: number;
    readonly context: McpMemoryToolCallContext;
  }): Promise<void> {
    if (deps.eventPublisher === undefined) {
      return;
    }
    const occurredAt = now();
    const queryHash = createHash("sha256").update(input.query).digest("hex").slice(0, 16);
    const event = {
      event_type: RecallContextEventType.SOUL_RECALL_DELIVERED,
      entity_type: "context_delivery",
      entity_id: input.deliveryId,
      workspace_id: input.context.workspaceId,
      run_id: input.context.runId,
      caused_by: input.context.agentTarget,
      payload_json: SoulRecallDeliveredPayloadSchema.parse({
        delivery_id: input.deliveryId,
        session_id: input.context.sessionId,
        run_id: input.context.runId,
        agent_target: input.context.agentTarget,
        query_hash: queryHash,
        pointer_count: input.pointerCount,
        latency_ms: Math.max(0, Math.trunc(input.latencyMs)),
        workspace_id: input.context.workspaceId,
        occurred_at: occurredAt
      })
    } as const;
    try {
      await deps.eventPublisher.appendManyWithMutation([event], () => undefined);
    } catch {
      // INVARIANT: telemetry append never throws to the MCP caller.
    }
  }

  async function openPointer(request: SoulOpenPointerRequest, context: McpMemoryToolCallContext) {
    // SECURITY (invariants §30 Fix at Source): use the scoped service method
    // so cross-workspace lookup is blocked at the service layer, not just at
    // this handler. Any future caller of memoryService.findById must take the
    // same precaution; new MCP/CLI surfaces should call findByIdScoped.
    const memory = await deps.memoryService.findByIdScoped(
      request.object_id,
      context.workspaceId
    );
    if (memory === null) {
      throw new ToolNotFoundError(`Memory object not found: ${request.object_id}`);
    }

    // Explicit projection: do not spread MemoryEntry. Internal fields
    // (lifecycle_state, created_by, storage_tier, workspace_id, ...) must
    // not leak to the attached agent.
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
      ...request,
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
    // A1 fix-loop (finding-2): workspace_id has been removed from the
    // public request schema; workspace is bound from the trusted MCP
    // call context. The previous handler-level "must match" guard is
    // therefore unnecessary — the workflow reads context.workspaceId
    // directly. Pattern matches soul.explore_graph.
    const result = await deps.proposalWorkflow.listPendingProposals(request, context);
    return SoulListPendingProposalsResponseSchema.parse({
      proposals: result.proposals,
      total_count: result.total_count
    });
  }

  async function listPendingGardenTasks(
    request: GardenListPendingTasksRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new ToolUnavailableError("Garden task queue is not available.");
    }
    const rows = deps.gardenTaskRepo.peekPending(
      mapGardenMcpWorkerRole(request.role),
      context.workspaceId,
      request.limit
    );
    return GardenListPendingTasksResponseSchema.parse({
      tasks: rows.map(toGardenTaskSnapshot)
    });
  }

  async function claimGardenTask(
    request: GardenClaimTaskRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new ToolUnavailableError("Garden task queue is not available.");
    }

    const claimedAt = now();
    const claimResult = deps.gardenTaskRepo.claimAtomic(
      request.task_id,
      context.agentTarget,
      claimedAt,
      context.workspaceId
    );
    const row = deps.gardenTaskRepo.findById(request.task_id);
    if (row === null || row.workspace_id !== context.workspaceId) {
      return GardenClaimTaskResponseSchema.parse(toSilentAlreadyClaimed(request.task_id));
    }
    if (claimResult !== "claimed" && row.claimed_by !== context.agentTarget) {
      return GardenClaimTaskResponseSchema.parse(toSilentAlreadyClaimed(request.task_id));
    }

    return GardenClaimTaskResponseSchema.parse({
      status: claimResult === "claimed" ? "claimed" : "already_claimed",
      ...toGardenClaimTaskPayload(row)
    });
  }

  async function completeGardenTask(
    request: GardenCompleteTaskRequest,
    context: McpMemoryToolCallContext
  ) {
    if (deps.gardenTaskRepo === undefined) {
      throw new ToolUnavailableError("Garden task queue is not available.");
    }

    const row = deps.gardenTaskRepo.findById(request.task_id);
    if (row === null || row.workspace_id !== context.workspaceId) {
      throw new ToolNotFoundError(`Garden task not found: ${request.task_id}`);
    }

    if (row.status !== "claimed") {
      throw new ToolValidationError(
        `Garden task ${row.id} is not in claimed state (current: ${row.status}); claim it via garden.claim_task before completing.`
      );
    }
    if (row.claimed_by !== context.agentTarget) {
      throw new ToolValidationError(
        `Garden task ${row.id} is claimed by a different agent target; only the claimant may complete it.`
      );
    }

    const taskPayloadRunId =
      isUnknownRecord(row.payload) && typeof row.payload.run_id === "string" && row.payload.run_id.length > 0
        ? row.payload.run_id
        : null;
    const resolvedRunId = taskPayloadRunId ?? context.runId;

    const contentOnlySignals = request.result_envelope?.candidate_signals ?? [];
    const completionEnvelopeJson =
      contentOnlySignals.length === 0
        ? null
        : buildGardenCompletionEnvelopeJson(row.id, contentOnlySignals);

    if (contentOnlySignals.length > 0 && resolvedRunId === null) {
      throw new ToolValidationError(
        "garden.complete_task cannot emit candidate_signals without a run_id in the task payload or MCP call context."
      );
    }
    if (row.completion_envelope_json !== null && row.completion_envelope_json !== completionEnvelopeJson) {
      throw new ToolValidationError(
        `Garden task ${row.id} candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope.`
      );
    }

    const completionClaimedBy =
      contentOnlySignals.length === 0
        ? context.agentTarget
        : `${context.agentTarget}:complete:${generateId()}`;
    if (contentOnlySignals.length > 0) {
      const completionClaimStarted = deps.gardenTaskRepo.beginCompletionAttempt(
        row.id,
        context.agentTarget,
        completionClaimedBy,
        now(),
        completionEnvelopeJson
      );
      if (!completionClaimStarted) {
        throw new ToolValidationError(
          `Garden task ${row.id} claim changed before candidate signal emission; retry after claiming the task again.`
        );
      }
    }

    const emittedSignalIds: string[] = [];
    try {
      for (const [index, signalContent] of contentOnlySignals.entries()) {
        const internalSignal = normalizeSchemaGroundedSignal(CandidateMemorySignalSchema.parse({
          signal_id: buildGardenTaskSignalId(row.id, index),
          ...signalContent,
          workspace_id: context.workspaceId,
          run_id: resolvedRunId,
          surface_id: null,
          source: SignalSource.GARDEN_COMPILE,
          created_at: now()
        }));
        const received = await deps.signalService.receiveSignal(internalSignal);
        emittedSignalIds.push(received.signal.signal_id);
      }

      const completedAt = now();
      const event: GardenTaskEventInput = {
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_type: "garden_task",
        entity_id: row.id,
        workspace_id: context.workspaceId,
        run_id: resolvedRunId,
        caused_by: context.agentTarget,
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
          task_id: row.id,
          task_kind: row.kind,
          role: row.role,
          tier: GARDEN_ROLE_TIER_MAP[row.role],
          success: request.status === "completed",
          objects_affected: emittedSignalIds,
          candidate_signals_count: emittedSignalIds.length,
          workspace_id: context.workspaceId,
          occurred_at: completedAt
        })
      };

      await deps.gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: request.status,
          completed_at: completedAt,
          ...(request.last_error_text === undefined ? {} : { last_error_text: request.last_error_text })
        },
        [event],
        completionClaimedBy
      );
    } catch (error) {
      if (contentOnlySignals.length > 0) {
        const released = deps.gardenTaskRepo.releaseClaim(row.id, completionClaimedBy);
        if (!released) {
          warn("Garden task completion claim could not be released after partial failure.", {
            task_id: row.id,
            claimed_by: completionClaimedBy,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      throw error;
    }

    return GardenCompleteTaskResponseSchema.parse({
      task_id: row.id,
      status: request.status,
      events_appended: 1
    });
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

  async function reportContextUsage(
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext
  ) {
    const reportedAt = now();
    validateUsageStateConsistency(request);
    await validateReportedRecallHits(request, context.workspaceId);
    const usageState = resolveUsageState(request);
    const usedObjectIds = resolveUsedObjectIds(request);
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: usageState,
        used_object_ids: usedObjectIds,
        ...(request.per_anchor_usage === undefined
          ? {}
          : { per_anchor_usage: request.per_anchor_usage }),
        reason: request.reason ?? null,
        reported_at: reportedAt
      },
      { expectedWorkspaceId: context.workspaceId }
    );
    // INVARIANT: stats attribution follows the linked delivery, not the
    // reporter's MCP context — a delayed retry / CLI fallback report
    // would otherwise count usage under the wrong run/agent and skew
    // used_ratio vs the trust-state proof.
    const linkedDelivery = await deps.trustStateRecorder.findDeliveryById(request.delivery_id);
    await promoteRecallHitMemories(request, context, linkedDelivery, reportedAt);
    enqueuePostTurnExtractTask(request, context, linkedDelivery);
    await emitContextUsageReportedTelemetry({
      deliveryId: request.delivery_id,
      usageState,
      occurredAt: reportedAt,
      context,
      linkedDelivery
    });
    return SoulReportContextUsageResponseSchema.parse({
      delivery_id: request.delivery_id,
      status: "recorded"
    });
  }

  async function emitContextUsageReportedTelemetry(input: {
    readonly deliveryId: string;
    readonly usageState: SoulReportContextUsageRequest["usage_state"];
    readonly occurredAt: string;
    readonly context: McpMemoryToolCallContext;
    readonly linkedDelivery: Readonly<ContextDeliveryRecord> | null;
  }): Promise<void> {
    if (deps.eventPublisher === undefined) {
      return;
    }
    const attributedRunId = input.linkedDelivery?.run_id ?? input.context.runId;
    const attributedAgentTarget = input.linkedDelivery?.agent_target ?? input.context.agentTarget;
    const attributedWorkspaceId = input.linkedDelivery?.workspace_id ?? input.context.workspaceId;
    const event = {
      event_type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      entity_type: "context_delivery",
      entity_id: input.deliveryId,
      workspace_id: attributedWorkspaceId,
      run_id: attributedRunId,
      caused_by: attributedAgentTarget,
      payload_json: SoulContextUsageReportedPayloadSchema.parse({
        delivery_id: input.deliveryId,
        session_id: input.context.sessionId,
        run_id: attributedRunId,
        agent_target: attributedAgentTarget,
        usage_state: input.usageState,
        workspace_id: attributedWorkspaceId,
        occurred_at: input.occurredAt
      })
    } as const;
    try {
      await deps.eventPublisher.appendManyWithMutation([event], () => undefined);
    } catch {
      // INVARIANT: telemetry append never throws to the MCP caller.
    }
  }

  function resolveReportSideEffectAttribution(
    linkedDelivery: Readonly<ContextDeliveryRecord> | null,
    context: McpMemoryToolCallContext
  ): {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly agentTarget: string;
  } | null {
    if (linkedDelivery === null) {
      return null;
    }

    return {
      workspaceId: linkedDelivery.workspace_id ?? context.workspaceId,
      runId: linkedDelivery.run_id,
      agentTarget: linkedDelivery.agent_target
    };
  }

  async function validateReportedRecallHits(
    request: SoulReportContextUsageRequest,
    workspaceId: string
  ): Promise<void> {
    const usedObjectIds = resolveUsedObjectIds(request);
    if (usedObjectIds.length === 0) {
      return;
    }

    await Promise.all(
      usedObjectIds.map(async (objectId) => {
        const memory = await deps.memoryService.findByIdScoped(objectId, workspaceId);
        if (memory === null) {
          throw new ToolNotFoundError(`Memory entry ${objectId} was not found.`);
        }
      })
    );
  }

  async function refreshReportedRecallHits(
    request: SoulReportContextUsageRequest,
    workspaceId: string,
    reportedAt: string
  ): Promise<void> {
    const usedObjectIds = resolveUsedObjectIds(request);
    if (usedObjectIds.length === 0) {
      return;
    }

    await Promise.all(
      usedObjectIds.map(async (objectId) => {
        await refreshScopedRecallUsage(
          objectId,
          workspaceId,
          reportedAt
        );
      })
    );
  }

  async function refreshScopedRecallUsage(
    objectId: string,
    workspaceId: string,
    reportedAt: string
  ): Promise<void> {
    if (deps.memoryService.updateScoped === undefined) {
      return;
    }
    await deps.memoryService.updateScoped(
      objectId,
      workspaceId,
      {
        storage_tier: StorageTier.HOT,
        last_used_at: reportedAt,
        last_hit_at: reportedAt
      },
      "recall_usage_reported"
    );
  }

  // Auto-extract path: enqueue a POST_TURN_EXTRACT task from the turn text the
  // host already sends on soul.recall, so durable capture does not depend on
  // the host echoing a turn_digest on report_context_usage or filing an
  // explicit proposal. Deduped by (workspace, run, turn-text hash) so repeated
  // recalls for the same turn collapse to one task.
  // see also: garden-runtime.ts processPostTurnExtractTask (consumes the task).
  function enqueueRecallExtractTask(
    request: SoulMemorySearchRequest,
    context: McpMemoryToolCallContext,
    deliveredObjectIds: readonly string[]
  ): void {
    const gardenTaskRepo = deps.gardenTaskRepo;
    if (gardenTaskRepo === undefined || context.runId === null) {
      return;
    }
    const turnText = (request.recent_turn ?? request.query).trim();
    if (turnText.length < MIN_AUTO_EXTRACT_TURN_CHARS) {
      return;
    }
    const workspaceId = context.workspaceId;
    const runId = context.runId;
    const dedupedDeliveredIds = Object.freeze([...new Set(deliveredObjectIds)]);
    const taskId = buildRecallExtractTaskId(workspaceId, runId, turnText);
    const createdAt = now();
    // Best-effort capture: a dropped extract task is acceptable; a storage
    // hiccup must not break recall. Swallow everything but a duplicate (already
    // queued for this turn) and log.
    try {
      if (
        gardenTaskRepo.peekPending(
          GardenRole.LIBRARIAN,
          workspaceId,
          RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD
        ).length >= RECALL_EXTRACT_BACKLOG_SKIP_THRESHOLD
      ) {
        return;
      }
      gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: workspaceId,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: buildPostTurnExtractPayload({
          taskId,
          workspaceId,
          runId,
          deliveredObjectIds: dedupedDeliveredIds,
          createdAt,
          turnIndex: 0,
          lastMessages: [
            {
              role: "user",
              content_excerpt: turnText.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
            }
          ]
        }),
        created_at: createdAt
      });
    } catch (error) {
      if (isDuplicatePostTurnExtractTask(error)) {
        return;
      }
      warn("recall-driven extract task enqueue failed; skipping.", {
        workspace_id: workspaceId,
        run_id: runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function enqueuePostTurnExtractTask(
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext,
    linkedDelivery: Readonly<ContextDeliveryRecord> | null
  ): void {
    const attribution = resolveReportSideEffectAttribution(linkedDelivery, context);
    if (
      deps.gardenTaskRepo === undefined ||
      attribution === null ||
      attribution.runId === null ||
      request.turn_index === undefined ||
      // Extract needs turn text; without a turn_digest the recall-driven
      // enqueueRecallExtractTask already covered this turn. Tier-promote
      // (resolveUsedObjectIds) stays separate — there is nothing to promote
      // when no object was used, but a cold-store turn is still worth extracting.
      (request.turn_digest?.last_messages?.length ?? 0) === 0
    ) {
      return;
    }

    const workspaceId = attribution.workspaceId;
    const runId = attribution.runId;
    const turnIndex = request.turn_index;
    const deliveredObjectIds = resolveDeliveredObjectIds(request);
    const lastMessages = normalizeTurnDigestMessages(request.turn_digest?.last_messages ?? []);
    if (hasRecallExtractTaskForTurnDigest(deps.gardenTaskRepo, workspaceId, runId, lastMessages)) {
      return;
    }
    const taskId = buildPostTurnExtractTaskId(workspaceId, runId, turnIndex);
    const createdAt = now();

    try {
      deps.gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: workspaceId,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: buildPostTurnExtractPayload({
          taskId,
          workspaceId,
          runId,
          deliveredObjectIds,
          createdAt,
          turnIndex,
          lastMessages
        }),
        created_at: createdAt
      });
    } catch (error) {
      if (isDuplicatePostTurnExtractTask(error)) {
        return;
      }
      throw error;
    }
  }

  async function promoteRecallHitMemories(
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext,
    linkedDelivery: Readonly<ContextDeliveryRecord> | null,
    reportedAt: string
  ): Promise<void> {
    const attribution = resolveReportSideEffectAttribution(linkedDelivery, context);
    if (attribution === null) {
      return;
    }

    if (deps.eventPublisher === undefined || deps.memoryEntryRepo === undefined) {
      await refreshReportedRecallHits(request, attribution.workspaceId, reportedAt);
      return;
    }

    // resolveUsedObjectIds is the single canonical "used object id" list, so
    // the recall-hit → tier promotion path here and the POST_TURN_EXTRACT
    // enqueue path see the same set regardless of which request shape the host
    // filled in (`delivered_objects[].usage_status` vs top-level
    // `usage_state`+`used_object_ids`).
    const usedObjectIds = resolveUsedObjectIds(request);
    for (const objectId of usedObjectIds) {
      const current = await deps.memoryService.findByIdScoped(objectId, attribution.workspaceId);
      if (current === null) {
        continue;
      }
      if (current.storage_tier === StorageTier.HOT) {
        await refreshScopedRecallUsage(
          objectId,
          attribution.workspaceId,
          reportedAt
        );
        continue;
      }

      const occurredAt = reportedAt;
      const event = {
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
        entity_type: "memory_entry",
        entity_id: current.object_id,
        workspace_id: attribution.workspaceId,
        run_id: attribution.runId,
        caused_by: attribution.agentTarget,
        payload_json: SoulMemoryTierPromotedPayloadSchema.parse({
          object_id: current.object_id,
          object_kind: current.object_kind,
          workspace_id: attribution.workspaceId,
          run_id: attribution.runId,
          from_tier: current.storage_tier,
          to_tier: StorageTier.HOT,
          reason: "recall_hit",
          occurred_at: occurredAt
        })
      } as const;

      try {
        await deps.eventPublisher.appendManyWithMutation([event], () => {
          const updated = deps.memoryEntryRepo?.updateTier({
            objectId: current.object_id,
            workspaceId: attribution.workspaceId,
            fromTier: current.storage_tier,
            toTier: StorageTier.HOT,
            updatedAt: occurredAt,
            expectedUpdatedAt: current.updated_at,
            activationBump: RECALL_HIT_ACTIVATION_BUMP,
            lastUsedAt: occurredAt,
            lastHitAt: occurredAt
          });
          if (updated === null || updated === undefined) {
            // Roll back the already-appended audit row when the CAS predicate loses.
            throw new RecallHitTierPromotionCasMiss();
          }
          return updated;
        });
      } catch (error) {
        if (error instanceof RecallHitTierPromotionCasMiss) {
          continue;
        }
        throw error;
      }
    }
  }
}

// One canonical "used object id" list for the report_context_usage handler:
// the recall-hit → tier promotion path and the POST_TURN_EXTRACT enqueue path
// both consume this, so a request that fills only one shape never produces a
// half side-effect. Modern shape (preferred): `delivered_objects[]` with
// per-object `usage_status` — take only those whose status is "used". Legacy
// shape: top-level `usage_state === "used"` + `used_object_ids`.
function resolveUsedObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    const usedIds = request.delivered_objects
      .filter((object) => object.usage_status === "used")
      .map((object) => object.object_id);
    return Object.freeze(Array.from(new Set(usedIds)));
  }
  if (request.usage_state === "used") {
    return Object.freeze(Array.from(new Set(request.used_object_ids ?? [])));
  }
  return Object.freeze([]);
}

function resolveUsageState(request: SoulReportContextUsageRequest): SoulReportContextUsageRequest["usage_state"] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    return deriveDeliveredObjectsUsageState(request.delivered_objects);
  }
  return request.usage_state;
}

function validateUsageStateConsistency(request: SoulReportContextUsageRequest): void {
  const deliveredObjects = request.delivered_objects;
  if (deliveredObjects !== undefined && deliveredObjects.length > 0) {
    const derivedUsageState = deriveDeliveredObjectsUsageState(deliveredObjects);
    if (request.usage_state !== derivedUsageState) {
      throw new ToolValidationError(
        `usage_state ${request.usage_state} contradicts delivered_objects aggregate usage_state ${derivedUsageState}.`
      );
    }
    if (request.used_object_ids !== undefined) {
      const reportedIds = [...new Set(request.used_object_ids)].sort();
      const deliveredUsedIds = [...new Set(
        deliveredObjects
          .filter((object) => object.usage_status === "used")
          .map((object) => object.object_id)
      )].sort();
      if (reportedIds.join("\0") !== deliveredUsedIds.join("\0")) {
        throw new ToolValidationError("used_object_ids contradict delivered_objects usage_status values.");
      }
    }
    return;
  }

  if (request.usage_state !== "used" && (request.used_object_ids?.length ?? 0) > 0) {
    throw new ToolValidationError("used_object_ids can only be supplied when usage_state is used.");
  }
}

function deriveDeliveredObjectsUsageState(
  deliveredObjects: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>
): SoulReportContextUsageRequest["usage_state"] {
  if (deliveredObjects.some((object) => object.usage_status === "used")) {
    return "used";
  }
  if (deliveredObjects.some((object) => object.usage_status === "skipped")) {
    return "skipped";
  }
  return "not_applicable";
}

// All delivered object ids regardless of usage_status — used for the
// turn_digest manifest so the extract task sees what was delivered, not just
// what was used.
function resolveDeliveredObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
  const ids =
    request.delivered_objects === undefined
      ? request.used_object_ids ?? []
      : request.delivered_objects.map((object) => object.object_id);
  return Object.freeze([...new Set(ids)]);
}

function buildGardenCompletionEnvelopeJson(
  taskId: string,
  signals: readonly GardenCompletionCandidateSignal[]
): string {
  const signalIds = signals.map((_, index) => buildGardenTaskSignalId(taskId, index));
  const fingerprint = createHash("sha256")
    .update(stableStringify({
      task_id: taskId,
      candidate_signal_ids: signalIds,
      candidate_signals: signals
    }))
    .digest("hex");

  return JSON.stringify({
    version: 1,
    task_id: taskId,
    candidate_signal_count: signals.length,
    candidate_signal_ids: signalIds,
    fingerprint
  });
}

function normalizeTurnDigestMessages(
  messages: NonNullable<SoulReportContextUsageRequest["turn_digest"]>["last_messages"]
): readonly { readonly role: string; readonly content_excerpt: string }[] {
  return Object.freeze(
    messages.map((message) =>
      Object.freeze({
        role: message.role,
        content_excerpt: message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
      })
    )
  );
}

function hasRecallExtractTaskForTurnDigest(
  gardenTaskRepo: NonNullable<McpMemoryToolHandlerDependencies["gardenTaskRepo"]>,
  workspaceId: string,
  runId: string,
  messages: readonly { readonly role: string; readonly content_excerpt: string }[]
): boolean {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const turnText = message.content_excerpt.trim();
    if (turnText.length < MIN_AUTO_EXTRACT_TURN_CHARS) {
      continue;
    }
    if (gardenTaskRepo.findById(buildRecallExtractTaskId(workspaceId, runId, turnText)) !== null) {
      return true;
    }
  }
  return false;
}

function buildPostTurnExtractPayload(input: {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly deliveredObjectIds: readonly string[];
  readonly createdAt: string;
  readonly turnIndex: number;
  readonly lastMessages: readonly { readonly role: string; readonly content_excerpt: string }[];
}): Readonly<{
  readonly task_id: string;
  readonly task_kind: typeof GardenTaskKind.POST_TURN_EXTRACT;
  readonly required_tier: typeof GardenTier.TIER_2;
  readonly run_id: string;
  readonly target_object_refs: readonly string[];
  readonly priority: 20;
  readonly created_at: string;
  readonly turn_index: number;
  readonly workspace_id: string;
  readonly turn_digest: {
    readonly last_messages: readonly { readonly role: string; readonly content_excerpt: string }[];
    readonly context_manifest: { readonly delivered_object_ids: readonly string[] };
  };
}> {
  return Object.freeze({
    task_id: input.taskId,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    required_tier: GardenTier.TIER_2,
    run_id: input.runId,
    target_object_refs: input.deliveredObjectIds,
    priority: 20,
    created_at: input.createdAt,
    turn_index: input.turnIndex,
    workspace_id: input.workspaceId,
    turn_digest: Object.freeze({
      last_messages: input.lastMessages,
      context_manifest: Object.freeze({
        delivered_object_ids: input.deliveredObjectIds
      })
    })
  });
}

function buildPostTurnExtractTaskId(
  workspaceId: string,
  runId: string,
  turnIndex: number
): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(String(turnIndex))
    .digest("hex")
    .slice(0, 32);
  // Dedup key is (workspace_id, run_id, turn_index): the deterministic task
  // id lets SQLite's existing garden_tasks primary-key constraint act as the
  // duplicate guard.
  return `post_turn_extract_${digest}`;
}

function buildRecallExtractTaskId(workspaceId: string, runId: string, turnText: string): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(turnText)
    .digest("hex")
    .slice(0, 32);
  // Dedup key is (workspace_id, run_id, turn-text hash): repeated recalls for
  // the same conversation turn collapse to one extract task via the
  // garden_tasks primary key. Distinct from buildPostTurnExtractTaskId (which
  // keys on turn_index) so a recall-driven and a report-driven task for the
  // same turn do not collide.
  return `recall_extract_${digest}`;
}

// Detect a POST_TURN_EXTRACT enqueue dedupe via the structured
// StorageError("DUPLICATE_KEY", ...) code the storage repo raises from
// enqueue() on a primary-key collision — not by scanning better-sqlite3's
// error text, which would couple this to the library's message format. Falls
// back to message-substring detection only as a defensive safety net.
function isDuplicatePostTurnExtractTask(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (code === "DUPLICATE_KEY") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRecallPolicy(
  request: SoulMemorySearchRequest,
  taskSurfaceId: string,
  policyId: string
): RecallPolicy {
  return {
    runtime_id: policyId,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceId,
    expires_at: null,
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: request.scope_class === null ? null : [ScopeClassSchema.parse(request.scope_class)],
        dimension_filter: request.dimension === null ? null : [MemoryDimensionSchema.parse(request.dimension)],
        domain_tag_filter: request.domain_tags
      },
      precomputed_rank: {
        max_candidates: Math.max(request.max_results, 1),
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: Math.max(Math.ceil(request.max_results / 2), 1),
        embedding_enabled: true
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: Math.max(request.max_results, 1),
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

function mapGardenMcpWorkerRole(role: GardenMcpWorkerRole | undefined): GardenRoleValue {
  switch (role) {
    case "janitor":
      return GardenRole.JANITOR;
    case "auditor":
      return GardenRole.AUDITOR;
    case "librarian":
    case "host_worker":
    case undefined:
      return GardenRole.LIBRARIAN;
  }
}

function toGardenTaskSnapshot(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    created_at: row.created_at,
    payload: publicGardenTaskPayload(row)
  };
}

function toGardenClaimTaskPayload(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    payload: publicGardenTaskPayload(row)
  };
}

function gardenWorkerRoleForRow(row: GardenTaskRow): string {
  return row.kind === GardenTaskKind.POST_TURN_EXTRACT ? "host_worker" : row.role;
}

function publicGardenTaskPayload(row: GardenTaskRow): unknown {
  if (row.kind !== GardenTaskKind.POST_TURN_EXTRACT || !isUnknownRecord(row.payload)) {
    return row.payload;
  }

  return {
    run_id: row.payload.run_id,
    turn_index: row.payload.turn_index,
    workspace_id: row.payload.workspace_id,
    turn_digest: row.payload.turn_digest
  };
}

function toSilentAlreadyClaimed(taskId: string) {
  return {
    status: "already_claimed",
    task_id: taskId,
    role: "unknown",
    kind: "unknown",
    payload: null
  };
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
