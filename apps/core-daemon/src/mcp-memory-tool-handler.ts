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
  RetentionPolicy,
  ScopeClassSchema,
  SignalSource,
  SoulApplyOverrideRequestSchema,
  SoulApplyOverrideResponseSchema,
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

const RECALL_HIT_ACTIVATION_BUMP = 0.05;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;

export interface McpMemoryToolCallContext {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
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
      fields: MemoryEntryMutableFields,
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
      events: readonly GardenTaskEventInput[]
    ): Promise<void>;
  };
  readonly now?: () => string;
  readonly generateId?: () => string;
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
    const recallResult = await deps.recallService.recall({
      taskSurface,
      workspaceId: context.workspaceId,
      strategy: "chat",
      runId: context.runId,
      policyOverride
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
    const signal = CandidateMemorySignalSchema.parse({
      signal_id: `signal_${generateId()}`,
      ...request,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      surface_id: context.surfaceId ?? null,
      source: SignalSource.MODEL_TOOL,
      created_at: now()
    });
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

    // Wave-end M1 (§29): host-supplied candidate_signals carry only
    // content fields (McpEmitCandidateSignalRequestSchema). The daemon
    // binds workspace_id / run_id / surface_id / source from the trusted
    // task row + MCP context — never from host payload — so a host
    // cannot self-report `source: "user_seed"` or a foreign run_id and
    // sneak past the §29 default-scope guard.
    const contentOnlySignals = request.result_envelope?.candidate_signals ?? [];

    // Wave-end M2 (§10): emit candidate signals BEFORE writing
    // SOUL_GARDEN_TASK_COMPLETED. The prior order committed the
    // task-completed event up front (claiming N signals were emitted)
    // and then looped receiveSignal — if the loop threw mid-batch, the
    // audit row had already lied. Emitting first means a partial failure
    // leaves the task in `claimed` (recovery via gcAbandonedClaims or
    // host retry) without ever publishing a task-completed event whose
    // objects_affected list does not match reality.
    const emittedSignalIds: string[] = [];
    for (const signalContent of contentOnlySignals) {
      const internalSignal = CandidateMemorySignalSchema.parse({
        signal_id: `signal_${generateId()}`,
        ...signalContent,
        workspace_id: context.workspaceId,
        run_id: context.runId ?? row.id,
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
      run_id: context.runId,
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
      [event]
    );

    return GardenCompleteTaskResponseSchema.parse({
      task_id: row.id,
      status: request.status,
      events_appended: 1
    });
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
    await deps.trustStateRecorder.recordUsage(
      {
        delivery_id: request.delivery_id,
        usage_state: request.usage_state,
        used_object_ids: request.used_object_ids ?? [],
        ...(request.per_anchor_usage === undefined
          ? {}
          : { per_anchor_usage: request.per_anchor_usage }),
        reason: request.reason ?? null,
        reported_at: now()
      },
      { expectedWorkspaceId: context.workspaceId }
    );
    await promoteRecallHitMemories(request, context);
    enqueuePostTurnExtractTask(request, context);
    return SoulReportContextUsageResponseSchema.parse({
      delivery_id: request.delivery_id,
      status: "recorded"
    });
  }

  function enqueuePostTurnExtractTask(
    request: SoulReportContextUsageRequest,
    context: McpMemoryToolCallContext
  ): void {
    if (
      deps.gardenTaskRepo === undefined ||
      context.runId === null ||
      request.turn_index === undefined ||
      !hasUsedDeliveredObject(request)
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
    context: McpMemoryToolCallContext
  ): Promise<void> {
    if (
      request.usage_state !== "used" ||
      deps.eventPublisher === undefined ||
      deps.memoryEntryRepo === undefined
    ) {
      return;
    }

    const usedObjectIds = Array.from(new Set(request.used_object_ids ?? []));
    for (const objectId of usedObjectIds) {
      const current = await deps.memoryService.findByIdScoped(objectId, context.workspaceId);
      if (current === null || current.storage_tier === StorageTier.HOT) {
        continue;
      }

      const occurredAt = now();
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
            activationBump: RECALL_HIT_ACTIVATION_BUMP
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

function hasUsedDeliveredObject(request: SoulReportContextUsageRequest): boolean {
  if (request.delivered_objects !== undefined) {
    return request.delivered_objects.some((object) => object.usage_status === "used");
  }

  return request.usage_state === "used" && (request.used_object_ids?.length ?? 0) > 0;
}

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
