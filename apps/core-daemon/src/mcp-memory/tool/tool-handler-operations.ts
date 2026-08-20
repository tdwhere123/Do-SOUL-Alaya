import {
  CandidateMemorySignalSchema,
  ProposalResolutionState,
  SignalSource,
  SoulApplyOverrideResponseSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulEmitCandidateSignalResponseSchema,
  SoulExploreGraphResponseSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulListPendingProposalsResponseSchema,
  SoulOpenPointerResponseSchema,
  SoulProposeEdgeResponseSchema,
  SoulProposeMemoryUpdateResponseSchema,
  SoulReviewMemoryProposalResponseSchema,
  type CandidateMemorySignal,
  type ContextDeliveryRecord,
  type GardenClaimTaskRequest,
  type GardenClaimTaskResponse,
  type GardenCompleteTaskRequest,
  type GardenCompleteTaskResponse,
  type GardenListPendingTasksRequest,
  type GardenListPendingTasksResponse,
  type SoulApplyOverrideRequest,
  type SoulApplyOverrideResponse,
  type SoulBatchReviewEdgeProposalsRequest,
  type SoulBatchReviewEdgeProposalsResponse,
  type SoulEmitCandidateSignalRequest,
  type SoulEmitCandidateSignalResponse,
  type SoulExploreGraphRequest,
  type SoulExploreGraphResponse,
  type SoulListPendingEdgeProposalsRequest,
  type SoulListPendingEdgeProposalsResponse,
  type SoulListPendingProposalsRequest,
  type SoulListPendingProposalsResponse,
  type SoulOpenPointerRequest,
  type SoulOpenPointerResponse,
  type SoulProposeEdgeRequest,
  type SoulProposeEdgeResponse,
  type SoulProposeMemoryUpdateRequest,
  type SoulProposeMemoryUpdateResponse,
  type SoulResolveResponse,
  type SoulReviewMemoryProposalRequest,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import {
  ToolNotFoundError,
  ToolUnavailableError,
  ToolValidationError,
  assertEdgeReviewCallerIsAllowed,
  normalizeCandidateSignalGraphRefs,
  resolveEdgeReviewerIdentity
} from "./tool-handler-support.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandlerDependencies
} from "./tool-handler-types.js";
import { createVerifiedDeliverySourceObservation } from "../../runtime/recall-materialization/recall-materialization-source-receipt.js";

export type GardenTaskOperations = Readonly<{
  listPendingGardenTasks(request: GardenListPendingTasksRequest, context: McpMemoryToolCallContext): Promise<GardenListPendingTasksResponse>;
  claimGardenTask(request: GardenClaimTaskRequest, context: McpMemoryToolCallContext): Promise<GardenClaimTaskResponse>;
  completeGardenTask(request: GardenCompleteTaskRequest, context: McpMemoryToolCallContext): Promise<GardenCompleteTaskResponse>;
}>;

type McpMemoryOperationFactoryInput = Readonly<{
  readonly deps: McpMemoryToolHandlerDependencies;
  readonly now: () => string;
  readonly generateId: () => string;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>;

export type McpMemoryToolOperations = Readonly<{
  openPointer(request: SoulOpenPointerRequest, context: McpMemoryToolCallContext): Promise<SoulOpenPointerResponse>;
  emitCandidateSignal(request: SoulEmitCandidateSignalRequest, context: McpMemoryToolCallContext): Promise<SoulEmitCandidateSignalResponse>;
  proposeMemoryUpdate(request: SoulProposeMemoryUpdateRequest, context: McpMemoryToolCallContext): Promise<SoulProposeMemoryUpdateResponse>;
  reviewMemoryProposal(request: SoulReviewMemoryProposalRequest, context: McpMemoryToolCallContext): Promise<SoulReviewMemoryProposalResponse>;
  listPendingProposals(request: SoulListPendingProposalsRequest, context: McpMemoryToolCallContext): Promise<SoulListPendingProposalsResponse>;
  proposeEdge(request: SoulProposeEdgeRequest, context: McpMemoryToolCallContext): Promise<SoulProposeEdgeResponse>;
  listPendingEdgeProposals(request: SoulListPendingEdgeProposalsRequest, context: McpMemoryToolCallContext): Promise<SoulListPendingEdgeProposalsResponse>;
  batchReviewEdgeProposals(request: SoulBatchReviewEdgeProposalsRequest, context: McpMemoryToolCallContext): Promise<SoulBatchReviewEdgeProposalsResponse>;
  applyOverride(request: SoulApplyOverrideRequest, context: McpMemoryToolCallContext): Promise<SoulApplyOverrideResponse>;
  resolveStagedWarning(rawArguments: unknown, context: McpMemoryToolCallContext): Promise<SoulResolveResponse>;
  exploreGraph(request: SoulExploreGraphRequest, context: McpMemoryToolCallContext): Promise<SoulExploreGraphResponse>;
}>;

export function createAgentSurfaceRegistrar(
  input: Readonly<{ readonly deps: McpMemoryToolHandlerDependencies; readonly warn: (message: string, meta: Record<string, unknown>) => void; }>
): Readonly<{ ensureAgentSurfaceForCall(context: McpMemoryToolCallContext): Promise<void>; }> {
  const registeredSurfaces = new Set<string>();
  return {
    ensureAgentSurfaceForCall: async (context) => {
      const registrar = input.deps.attachSurfaceRegistrar;
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
        input.warn("agent surface registration failed", {
          workspace_id: workspaceId,
          agent_target: agentTarget,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
}

export function createMcpMemoryToolOperations(input: McpMemoryOperationFactoryInput): McpMemoryToolOperations {
  return {
    openPointer: (request, context) => openPointer(input.deps, request, context),
    emitCandidateSignal: (request, context) => emitCandidateSignal(input, request, context),
    proposeMemoryUpdate: (request, context) => proposeMemoryUpdate(input.deps, request, context),
    reviewMemoryProposal: (request, context) => reviewMemoryProposal(input.deps, request, context),
    listPendingProposals: (request, context) => listPendingProposals(input.deps, request, context),
    proposeEdge: (request, context) => proposeEdge(input.deps, request, context),
    listPendingEdgeProposals: (request, context) => listPendingEdgeProposals(input.deps, request, context),
    batchReviewEdgeProposals: (request, context) => batchReviewEdgeProposals(input.deps, request, context),
    applyOverride: (request, context) => applyOverride(input.deps, request, context),
    resolveStagedWarning: (rawArguments, context) => resolveStagedWarning(input.deps, rawArguments, context),
    exploreGraph: (request, context) => exploreGraph(input.deps, request, context)
  };
}

async function openPointer(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulOpenPointerRequest,
  context: McpMemoryToolCallContext
): Promise<SoulOpenPointerResponse> {
  const memory = await deps.memoryService.findByIdScoped(request.object_id, context.workspaceId);
  if (memory !== null) return memoryPointerResponse(memory);
  const evidence = await deps.evidenceService?.findByIdScoped?.(request.object_id, context.workspaceId);
  if (evidence !== undefined && evidence !== null) return evidencePointerResponse(evidence);
  throw new ToolNotFoundError(`Pointer object not found: ${request.object_id}`);
}

function memoryPointerResponse(memory: Awaited<ReturnType<McpMemoryToolHandlerDependencies["memoryService"]["findByIdScoped"]>>) {
  if (memory === null) throw new ToolNotFoundError("Pointer object not found.");
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

function evidencePointerResponse(evidence: {
  readonly object_id: string;
  readonly object_kind: string;
  readonly schema_version: number;
  readonly gist: string | null;
  readonly excerpt: string | null;
}) {
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

async function emitCandidateSignal(
  input: McpMemoryOperationFactoryInput,
  request: SoulEmitCandidateSignalRequest,
  context: McpMemoryToolCallContext
): Promise<SoulEmitCandidateSignalResponse> {
  if (context.runId === null) {
    throw new ToolValidationError("soul.emit_candidate_signal requires a runId in the MCP call context.");
  }
  const deliveries = await validateSourceDeliveryAnchors(
    input.deps,
    request.source_delivery_ids,
    context
  );
  const signal = buildCandidateSignal(
    input,
    request,
    context,
    createVerifiedDeliverySourceObservation(deliveries)
  );
  warnIfModelToolSignalMissingDeliveryAnchor(signal, input.warn);
  const received = await input.deps.signalService.receiveSignal(signal);
  return SoulEmitCandidateSignalResponseSchema.parse({ signal_id: received.signal.signal_id, status: "emitted" });
}

function buildCandidateSignal(
  input: McpMemoryOperationFactoryInput,
  request: SoulEmitCandidateSignalRequest,
  context: McpMemoryToolCallContext,
  sourceObservation: CandidateMemorySignal["source_observation"]
): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: `signal_${input.generateId()}`,
    ...normalizeCandidateSignalGraphRefs(request, input.warn),
    workspace_id: context.workspaceId,
    run_id: context.runId,
    surface_id: context.surfaceId ?? null,
    source: SignalSource.MODEL_TOOL,
    source_observation: sourceObservation,
    created_at: input.now()
  });
}

async function proposeMemoryUpdate(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulProposeMemoryUpdateRequest,
  context: McpMemoryToolCallContext
): Promise<SoulProposeMemoryUpdateResponse> {
  const workflow = requireProposalWorkflow(deps);
  await validateSourceDeliveryAnchors(deps, request.source_delivery_ids, context);
  return SoulProposeMemoryUpdateResponseSchema.parse(await workflow.proposeMemoryUpdate(request, context));
}

async function reviewMemoryProposal(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulReviewMemoryProposalRequest,
  context: McpMemoryToolCallContext
): Promise<SoulReviewMemoryProposalResponse> {
  const reviewed = await requireProposalWorkflow(deps).reviewMemoryProposal(request, context);
  return SoulReviewMemoryProposalResponseSchema.parse({
    proposal_id: reviewed.proposal_id,
    resolution_state: reviewedProposalResolution(request, reviewed.resolution_state)
  });
}

function reviewedProposalResolution(
  request: SoulReviewMemoryProposalRequest,
  state: ProposalResolutionState
): ProposalResolutionState {
  return request.verdict === "accept" && state === ProposalResolutionState.PENDING
    ? ProposalResolutionState.ACCEPTED
    : state;
}

async function listPendingProposals(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulListPendingProposalsRequest,
  context: McpMemoryToolCallContext
): Promise<SoulListPendingProposalsResponse> {
  const result = await requireProposalWorkflow(deps).listPendingProposals(request, context);
  return SoulListPendingProposalsResponseSchema.parse({
    proposals: result.proposals,
    total_count: result.total_count
  });
}

function requireProposalWorkflow(deps: McpMemoryToolHandlerDependencies) {
  if (deps.proposalWorkflow === undefined) {
    throw new ToolUnavailableError("Memory proposal workflow is not available.");
  }
  return deps.proposalWorkflow;
}

async function proposeEdge(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulProposeEdgeRequest,
  context: McpMemoryToolCallContext
): Promise<SoulProposeEdgeResponse> {
  const service = requireEdgeProposalService(deps);
  return SoulProposeEdgeResponseSchema.parse(await service.proposeExplicitEdge({
    sourceMemoryId: request.source_memory_id,
    targetMemoryId: request.target_memory_id,
    edgeType: request.edge_type,
    confidence: Math.min(request.confidence, 0.5),
    reason: request.reason ?? null,
    workspaceId: context.workspaceId,
    runId: context.runId
  }));
}

async function listPendingEdgeProposals(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulListPendingEdgeProposalsRequest,
  context: McpMemoryToolCallContext
): Promise<SoulListPendingEdgeProposalsResponse> {
  return SoulListPendingEdgeProposalsResponseSchema.parse(
    requireEdgeProposalService(deps).listPending(context.workspaceId, request)
  );
}

async function batchReviewEdgeProposals(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulBatchReviewEdgeProposalsRequest,
  context: McpMemoryToolCallContext
): Promise<SoulBatchReviewEdgeProposalsResponse> {
  const service = requireEdgeProposalService(deps);
  assertEdgeReviewCallerIsAllowed(context, deps.reviewerIdentityBinding);
  const reviewerIdentity = resolveEdgeReviewerIdentity(request, deps.reviewerIdentityBinding);
  return SoulBatchReviewEdgeProposalsResponseSchema.parse(await service.batchReview({
    workspaceId: context.workspaceId,
    verdict: request.verdict,
    filter: request.filter,
    reason: request.reason,
    reviewerIdentity
  }));
}

function requireEdgeProposalService(deps: McpMemoryToolHandlerDependencies) {
  if (deps.edgeProposalService === undefined) {
    throw new ToolUnavailableError("Edge proposal service is not available.");
  }
  return deps.edgeProposalService;
}

async function applyOverride(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulApplyOverrideRequest,
  context: McpMemoryToolCallContext
): Promise<SoulApplyOverrideResponse> {
  if (context.runId === null) throw new ToolValidationError("soul.apply_override requires a run context.");
  const applied = await deps.sessionOverrideService.apply({
    runId: context.runId,
    workspaceId: context.workspaceId,
    targetObject: request.target_object,
    correction: request.correction,
    ...(request.priority === undefined ? {} : { priority: request.priority })
  });
  return SoulApplyOverrideResponseSchema.parse({ override_id: applied.runtime_id, status: "applied" });
}

async function resolveStagedWarning(
  deps: McpMemoryToolHandlerDependencies,
  rawArguments: unknown,
  context: McpMemoryToolCallContext
): Promise<SoulResolveResponse> {
  const handler = deps.soulResolveHandler;
  if (handler === undefined) throw new ToolUnavailableError("soul.resolve is not wired into this daemon");
  return await handler.resolve(rawArguments, {
    workspaceId: context.workspaceId,
    runId: context.runId,
    agentTarget: context.agentTarget,
    sessionId: context.sessionId
  });
}

async function exploreGraph(
  deps: McpMemoryToolHandlerDependencies,
  request: SoulExploreGraphRequest,
  context: McpMemoryToolCallContext
): Promise<SoulExploreGraphResponse> {
  const neighbors = await deps.graphExploreService.exploreOneHop(
    request.memory_id,
    context.workspaceId,
    graphExploreOptions(request, context)
  );
  return SoulExploreGraphResponseSchema.parse({ source_memory_id: request.memory_id, neighbors, count: neighbors.length });
}

function graphExploreOptions(request: SoulExploreGraphRequest, context: McpMemoryToolCallContext) {
  return {
    ...(request.edge_types === undefined ? {} : { edgeTypes: request.edge_types }),
    ...(request.direction === undefined ? {} : { direction: request.direction }),
    runId: context.runId
  };
}

async function validateSourceDeliveryAnchors(
  deps: McpMemoryToolHandlerDependencies,
  sourceDeliveryIds: readonly string[] | undefined,
  context: McpMemoryToolCallContext
): Promise<readonly Readonly<ContextDeliveryRecord>[]> {
  if (sourceDeliveryIds === undefined) {
    return [];
  }

  const deliveries: Readonly<ContextDeliveryRecord>[] = [];
  for (const deliveryId of sourceDeliveryIds) {
    const delivery = await deps.trustStateRecorder.findDeliveryById(deliveryId);
    if (!isSourceDeliveryInScope(delivery, context)) {
      throw new ToolValidationError(
        `source_delivery_ids contains an unknown or out-of-scope delivery_id: ${deliveryId}`
      );
    }
    deliveries.push(delivery);
  }
  return deliveries;
}

function isSourceDeliveryInScope(
  delivery: Readonly<ContextDeliveryRecord> | null,
  context: McpMemoryToolCallContext
): delivery is Readonly<ContextDeliveryRecord> {
  return delivery !== null &&
    delivery.agent_target === context.agentTarget &&
    delivery.workspace_id === context.workspaceId &&
    delivery.run_id === context.runId;
}

function warnIfModelToolSignalMissingDeliveryAnchor(
  signal: CandidateMemorySignal,
  warn: (message: string, meta: Record<string, unknown>) => void
): void {
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
