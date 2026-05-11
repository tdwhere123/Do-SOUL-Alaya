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
  type MemorySearchResult,
  type Proposal,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallPolicy,
  type RecallScoreFactors,
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
  type SoulRecallStrategyMix,
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
import { hasAlayaMemoryToolName, type AlayaMemoryToolName } from "./mcp-memory-tool-catalog.js";

type MemoryUsageRefreshFields = MemoryEntryMutableFields & {
  readonly last_used_at?: string;
  readonly last_hit_at?: string;
};

const RECALL_HIT_ACTIVATION_BUMP = 0.05;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;

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
    // A1 (HITL daemon backbone) — projects the workspace-scoped pending
    // queue. The handler enforces workspace via the trusted MCP call
    // context; the request payload's workspace_id is rejected if it
    // does not match (SECURITY: invariants §29 Default Scope).
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
      claimedAt: string
    ): boolean;
    refreshClaim(taskId: string, claimedBy: string, claimedAt: string): boolean;
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
    await deps.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: results.map((result) => result.object_id),
      delivered_at: now()
    });

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
    // SECURITY (p5-system-review-r2 F-r2-002 / invariants §30 Fix at Source):
    // Use the scoped service method so cross-workspace lookup is blocked at
    // the service layer, not just at this handler. Any future caller of
    // memoryService.findById must take the same precaution; new MCP/CLI
    // surfaces should call findByIdScoped.
    const memory = await deps.memoryService.findByIdScoped(
      request.object_id,
      context.workspaceId
    );
    if (memory === null) {
      throw new ToolNotFoundError(`Memory object not found: ${request.object_id}`);
    }

    // Explicit projection: do not spread MemoryEntry. Internal fields
    // (lifecycle_state, created_by, storage_tier, workspace_id, ...) must
    // not leak to the attached agent (p5-system-review-r3 MR-I05).
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
    // SECURITY (gate-6-delta I5; MR-B03 / invariants §29 Default Scope):
    // workspace_id / run_id / surface_id are NOT in the public MCP
    // request schema (see SoulEmitCandidateSignalRequestSchema /
    // McpEmitCandidateSignalRequestSchema). The daemon binds them from
    // the trusted MCP call context. The attached agent cannot redirect
    // signals to a foreign workspace because the schema rejects the
    // fields outright before this function runs.
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

    if (contentOnlySignals.length > 0 && resolvedRunId === null) {
      throw new ToolValidationError(
        "garden.complete_task cannot emit candidate_signals without a run_id in the task payload or MCP call context."
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
        now()
      );
      if (!completionClaimStarted) {
        throw new ToolValidationError(
          `Garden task ${row.id} claim changed before candidate signal emission; retry after claiming the task again.`
        );
      }
    }

    const emittedSignalIds: string[] = [];
    for (const signalContent of contentOnlySignals) {
      const internalSignal = CandidateMemorySignalSchema.parse({
        signal_id: `signal_${generateId()}`,
        ...signalContent,
        workspace_id: context.workspaceId,
        run_id: resolvedRunId,
        surface_id: null,
        source: SignalSource.GARDEN_COMPILE,
        created_at: now()
      });
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
    // SECURITY (p5-system-review-r2 F-r2-001 / invariants §29 Default Scope):
    // workspace is server-bound from the trusted MCP call context; payload
    // cannot redirect graph exploration to a foreign workspace.
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
    await validateReportedRecallHits(request, context.workspaceId);
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: request.usage_state,
        used_object_ids: request.used_object_ids ?? [],
        ...(request.per_anchor_usage === undefined
          ? {}
          : { per_anchor_usage: request.per_anchor_usage }),
        reason: request.reason ?? null,
        reported_at: reportedAt
      },
      { expectedWorkspaceId: context.workspaceId }
    );
    await promoteRecallHitMemories(request, context, reportedAt);
    enqueuePostTurnExtractTask(request, context);
    // INVARIANT: stats attribution follows the linked delivery, not the
    // reporter's MCP context — a delayed retry / CLI fallback report
    // would otherwise count usage under the wrong run/agent and skew
    // used_ratio vs the trust-state proof.
    const linkedDelivery = await deps.trustStateRecorder.findDeliveryById(request.delivery_id);
    await emitContextUsageReportedTelemetry({
      deliveryId: request.delivery_id,
      usageState: request.usage_state,
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

  async function validateReportedRecallHits(
    request: SoulReportContextUsageRequest,
    workspaceId: string
  ): Promise<void> {
    if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
      return;
    }
    if (request.usage_state !== "used") {
      return;
    }
    const usedObjectIds = Array.from(new Set(request.used_object_ids ?? []));
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

  function enqueuePostTurnExtractTask(
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext
  ): void {
    if (
      deps.gardenTaskRepo === undefined ||
      context.runId === null ||
      request.turn_index === undefined ||
      // Wave-end M4: share the canonical used-id resolver with R2 so a
      // single request produces consistent side-effects across the two
      // paths (no ghost extract task without a matching tier promote
      // and vice versa).
      resolveUsedObjectIds(request).length === 0
    ) {
      return;
    }

    const workspaceId = context.workspaceId;
    const runId = context.runId;
    const turnIndex = request.turn_index;
    const deliveredObjectIds = resolveDeliveredObjectIds(request);
    const taskId = buildPostTurnExtractTaskId(workspaceId, runId, turnIndex);
    const createdAt = now();

    try {
      deps.gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: workspaceId,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: {
          task_id: taskId,
          task_kind: GardenTaskKind.POST_TURN_EXTRACT,
          required_tier: GardenTier.TIER_2,
          run_id: runId,
          target_object_refs: deliveredObjectIds,
          priority: 20,
          created_at: createdAt,
          turn_index: turnIndex,
          workspace_id: workspaceId,
          turn_digest: {
            last_messages: normalizeTurnDigestMessages(request.turn_digest?.last_messages ?? []),
            context_manifest: {
              delivered_object_ids: deliveredObjectIds
            }
          }
        },
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
    reportedAt: string
  ): Promise<void> {
    if (deps.eventPublisher === undefined || deps.memoryEntryRepo === undefined) {
      await refreshReportedRecallHits(request, context.workspaceId, reportedAt);
      return;
    }

    // Wave-end M4: the canonical used-id list now drives R2 the same
    // way it drives H3. Pre-fix, R2 only saw `usage_state === "used"`
    // + `used_object_ids` and missed requests that exercised the
    // modern `delivered_objects[].usage_status === "used"` shape, so a
    // host using the new shape would queue a POST_TURN_EXTRACT task
    // (H3) but never trigger a tier promotion (R2). Same predicate
    // now.
    const usedObjectIds = resolveUsedObjectIds(request);
    for (const objectId of usedObjectIds) {
      const current = await deps.memoryService.findByIdScoped(objectId, context.workspaceId);
      if (current === null) {
        continue;
      }
      if (current.storage_tier === StorageTier.HOT) {
        await refreshScopedRecallUsage(
          objectId,
          context.workspaceId,
          reportedAt
        );
        continue;
      }

      const occurredAt = reportedAt;
      const event = {
        event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
        entity_type: "memory_entry",
        entity_id: current.object_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.agentTarget,
        payload_json: SoulMemoryTierPromotedPayloadSchema.parse({
          object_id: current.object_id,
          object_kind: current.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId,
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
            workspaceId: context.workspaceId,
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

// Wave-end M4: one canonical "used object id list" for the entire
// report_context_usage handler. Both R2 (recall hit → tier promotion)
// and H3 (POST_TURN_EXTRACT enqueue) used to compute "is this used"
// from different shapes of the same untrusted request — R2 looked at
// `usage_state`+`used_object_ids` and H3 looked at `delivered_objects`.
// A request that filled only one shape produced one side effect but
// not the other. Now both consume the same canonical list.
//
// Modern shape (preferred): `delivered_objects[]` with per-object
// `usage_status`. Take only those whose status is "used".
// Legacy shape: top-level `usage_state === "used"` + `used_object_ids`.
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

// All delivered object ids regardless of usage_status — used for the
// H3 turn_digest manifest so the extract task sees what was delivered,
// not just what was used.
function resolveDeliveredObjectIds(request: SoulReportContextUsageRequest): readonly string[] {
  const ids =
    request.delivered_objects === undefined
      ? request.used_object_ids ?? []
      : request.delivered_objects.map((object) => object.object_id);
  return Object.freeze([...new Set(ids)]);
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
  // Dedup key is (workspace_id, run_id, turn_index). H3 keeps the H1 repo
  // unchanged, so the deterministic task id lets SQLite's existing
  // garden_tasks primary-key constraint act as the duplicate guard.
  return `post_turn_extract_${digest}`;
}

// Wave-end M3: detect H3 POST_TURN_EXTRACT dedupe via the structured
// StorageError("DUPLICATE_KEY", ...) code that the storage repo now raises
// from enqueue() on a primary-key collision. The previous implementation
// scanned for SQLITE_CONSTRAINT + "garden_tasks.id" substring matches in
// the better-sqlite3 error message, which couples this contract to the
// library's internal text format. Falls back to message-substring
// detection only as a defensive safety net.
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

function buildMemorySearchResult(
  candidate: Readonly<RecallCandidate>,
  policy: RecallPolicy,
  index: number,
  usedTokensBeforeCandidate: number
): MemorySearchResult {
  return {
    object_id: candidate.object_id,
    object_kind: candidate.object_kind,
    relevance_score: candidate.relevance_score,
    content_preview: candidate.content_preview,
    evidence_pointers: [candidate.object_id],
    selection_reason: candidate.selection_reason ?? buildSelectionReason(candidate),
    source_channels: candidate.source_channels ?? buildSourceChannels(candidate),
    score_factors: candidate.score_factors ?? buildScoreFactors(candidate),
    budget_state: candidate.budget_state ?? buildBudgetState(candidate, policy, index, usedTokensBeforeCandidate)
  };
}

function buildSelectionReason(candidate: Readonly<RecallCandidate>): string {
  const origin = candidate.origin_plane === "global" ? "global recall" : "workspace recall";
  return `Selected by ${origin} with relevance ${candidate.relevance_score.toFixed(3)} and activation ${candidate.activation_score.toFixed(3)}.`;
}

function buildSourceChannels(candidate: Readonly<RecallCandidate>): readonly string[] {
  const channels = ["ranked_recall", candidate.origin_plane] as string[];
  if (candidate.is_advisory === true) {
    channels.push("advisory");
  }
  return channels;
}

function buildScoreFactors(candidate: Readonly<RecallCandidate>): RecallScoreFactors {
  return {
    activation: clampScore(candidate.activation_score),
    relevance: clampScore(candidate.relevance_score)
  };
}

function buildBudgetState(
  candidate: Readonly<RecallCandidate>,
  policy: RecallPolicy,
  index: number,
  usedTokensBeforeCandidate: number
): RecallBudgetState {
  const maxEntries = policy.fine_assessment.budgets.max_entries;
  const maxTotalTokens = policy.fine_assessment.budgets.max_total_tokens;
  const usedTokensThroughCandidate = usedTokensBeforeCandidate + candidate.token_estimate;

  return {
    token_estimate: candidate.token_estimate,
    max_entries: maxEntries,
    max_total_tokens: maxTotalTokens,
    remaining_entries: Math.max(maxEntries - index - 1, 0),
    remaining_tokens: Math.max(maxTotalTokens - usedTokensThroughCandidate, 0),
    within_budget: index < maxEntries && usedTokensThroughCandidate <= maxTotalTokens
  };
}

function buildRecallStrategyMix(
  policy: RecallPolicy,
  results: readonly Readonly<MemorySearchResult>[]
): SoulRecallStrategyMix {
  return {
    deterministic_match: true,
    precomputed_rank: policy.coarse_filter.precomputed_rank.max_candidates > 0,
    semantic_supplement: results.some(
      (result) =>
        result.source_channels.includes("semantic_supplement") ||
        result.score_factors.embedding_similarity !== undefined
    ),
    graph_support: results.some(
      (result) =>
        result.source_channels.includes("graph_support") ||
        (result.score_factors.graph_support ?? 0) > 0
    ),
    path_plasticity: results.some(
      (result) =>
        result.source_channels.includes("path_plasticity") ||
        (result.score_factors.path_plasticity ?? 0) > 0
    ),
    global_recall: results.some((result) => result.source_channels.includes("global"))
  };
}

function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 1);
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
