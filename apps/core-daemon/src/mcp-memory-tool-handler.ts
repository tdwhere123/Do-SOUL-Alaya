import { randomUUID } from "node:crypto";
import {
  CandidateMemorySignalSchema,
  ControlPlaneObjectKind,
  MemoryDimensionSchema,
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
  SoulMemorySearchRequestSchema,
  SoulMemorySearchResponseSchema,
  SoulOpenPointerRequestSchema,
  SoulOpenPointerResponseSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulProposeMemoryUpdateResponseSchema,
  SoulReportContextUsageRequestSchema,
  SoulReportContextUsageResponseSchema,
  SoulReviewMemoryProposalRequestSchema,
  SoulReviewMemoryProposalResponseSchema,
  TaskObjectSurfaceSchema,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type MemoryEntry,
  type Proposal,
  type RecallCandidate,
  type RecallPolicy,
  type SoulApplyOverrideRequest,
  type SoulEmitCandidateSignalRequest,
  type SoulExploreGraphRequest,
  type SoulMemorySearchRequest,
  type SoulOpenPointerRequest,
  type SoulProposeMemoryUpdateRequest,
  type SoulReportContextUsageRequest,
  type SoulReviewMemoryProposalRequest,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import { hasAlayaMemoryToolName, type AlayaMemoryToolName } from "./mcp-memory-tool-catalog.js";

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
    }>>;
  };
  readonly memoryService: {
    findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
    findByIdScoped(
      objectId: string,
      workspaceId: string
    ): Promise<Readonly<MemoryEntry> | null>;
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
    recordUsage(input: Omit<UsageProofRecord, "audit_event_id">): Promise<UsageProofRecord>;
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
        readonly code: "UNKNOWN_TOOL" | "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "INTERNAL";
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
          case "soul.apply_override":
            return ok(toolName, await applyOverride(SoulApplyOverrideRequestSchema.parse(rawArguments), context));
          case "soul.explore_graph":
            return ok(toolName, await exploreGraph(SoulExploreGraphRequestSchema.parse(rawArguments), context));
          case "soul.report_context_usage":
            return ok(toolName, await reportContextUsage(SoulReportContextUsageRequestSchema.parse(rawArguments), context));
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
    const recallResult = await deps.recallService.recall({
      taskSurface,
      workspaceId: context.workspaceId,
      strategy: "chat",
      runId: context.runId,
      policyOverride: buildRecallPolicy(request, taskSurface.runtime_id, generateId())
    });
    const results = recallResult.candidates.slice(0, request.max_results).map((candidate) => ({
      object_id: candidate.object_id,
      object_kind: candidate.object_kind,
      relevance_score: candidate.relevance_score,
      content_preview: candidate.content_preview,
      evidence_pointers: []
    }));
    const deliveryId = `delivery_${generateId()}`;
    await deps.trustStateRecorder.recordDelivery({
      delivery_id: deliveryId,
      agent_target: context.agentTarget,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      delivered_object_ids: results.map((result) => result.object_id),
      delivered_at: now()
    });

    return SoulMemorySearchResponseSchema.parse({
      delivery_id: deliveryId,
      results,
      total_count: recallResult.fine_assessment_count
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

    return SoulOpenPointerResponseSchema.parse({
      object_id: memory.object_id,
      object_kind: memory.object_kind,
      content: { ...memory }
    });
  }

  async function emitCandidateSignal(
    request: SoulEmitCandidateSignalRequest,
    context: McpMemoryToolCallContext
  ) {
    // SECURITY (p5-system-review-r1 MR-B03 / invariants §29 Default Scope):
    // Trusted MCP call context overrides any payload-supplied scope. The
    // attached agent (LLM) cannot redirect signals to a foreign workspace
    // by spoofing workspace_id / run_id / surface_id in the request body.
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
    _context: McpMemoryToolCallContext
  ) {
    await deps.trustStateRecorder.recordUsage({
      delivery_id: request.delivery_id,
      usage_state: request.usage_state,
      used_object_ids: request.used_object_ids ?? [],
      reason: request.reason ?? null,
      reported_at: now()
    });
    return SoulReportContextUsageResponseSchema.parse({
      delivery_id: request.delivery_id,
      status: "recorded"
    });
  }
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

function classifyError(error: unknown): "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "INTERNAL" {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "VALIDATION" || error.code === "UNAVAILABLE" || error.code === "NOT_FOUND")
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
