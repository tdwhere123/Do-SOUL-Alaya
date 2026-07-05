import {
  ControlPlaneObjectKind,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulReviewCompletedPayloadSchema,
  SoulReviewCreatedPayloadSchema,
  TransitionCausedBy,
  type EventLogEntry,
  type Proposal,
  type SoulListPendingProposalsRequest,
  type SoulPendingProposalSummary,
  type SoulProposeMemoryUpdateRequest,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "./tool-handler-types.js";
import {
  acceptProposalWithDurableMemoryUpdate,
  acceptProposalWithDurablePathRelationGovernance,
  acceptProposalWithDurableSynthesisCreate,
  prepareAcceptedProposalApply
} from "./proposal-acceptance.js";
import {
  assertProposalContext,
  assertReviewCallerIsAllowed,
  assertReviewerAssignment,
  createWorkflowError,
  normalizeResolutionError,
  resolveReviewerIdentity
} from "./proposal-workflow-reviewer.js";
import type { McpMemoryProposalWorkflowDependencies } from "./proposal-workflow.js";
import { buildProposalReviewKarmaMutation } from "./proposal-review-karma.js";
import {
  SourceDeliveryAnchorValidationError,
  type ProposalCreationEventInput,
  type ProposalResolutionEventInput
} from "./proposal-workflow-types.js";

type ProposalReviewResolutionOptions = Readonly<{
  readonly reviewerIdentity: string;
  readonly applySynchronousResolutionMutation?: () => readonly ProposalResolutionEventInput[];
}>;

export function createProposalWorkflowHandlers(input: Readonly<{
  readonly deps: McpMemoryProposalWorkflowDependencies;
  readonly now: () => string;
  readonly generateObjectId: () => string;
}>): Readonly<{
  proposeMemoryUpdate(
    request: SoulProposeMemoryUpdateRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{ proposal_id: string; status: "created" }>>;
  reviewMemoryProposal(
    request: SoulReviewMemoryProposalRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{ proposal_id: string; resolution_state: Proposal["resolution_state"] }>>;
  listPendingProposals(
    request: SoulListPendingProposalsRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{
    readonly proposals: readonly Readonly<SoulPendingProposalSummary>[];
    readonly total_count: number;
  }>>;
}> {
  return {
    proposeMemoryUpdate: async (request, context) =>
      await proposeMemoryUpdate(input, request, context),
    reviewMemoryProposal: async (request, context) =>
      await reviewMemoryProposal(input, request, context),
    listPendingProposals: async (request, context) =>
      await listPendingProposals(input, request, context)
  };
}

async function proposeMemoryUpdate(
  input: Readonly<{
    readonly deps: McpMemoryProposalWorkflowDependencies;
    readonly now: () => string;
    readonly generateObjectId: () => string;
  }>,
  request: SoulProposeMemoryUpdateRequest,
  context: McpMemoryToolCallContext
): Promise<Readonly<{ proposal_id: string; status: "created" }>> {
  const timestamp = input.now();
  const proposalId = input.generateObjectId();
  const sourceDeliveryIds = request.source_delivery_ids ?? null;
  await validateSourceDeliveryIds(input.deps, sourceDeliveryIds, context);
  const targetBaselineUpdatedAt = await readProposalTargetBaseline(
    input.deps,
    request.target_object_id,
    context.workspaceId
  );
  const proposal = ProposalSchema.parse({
    runtime_id: proposalId,
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: context.surfaceId ?? null,
    expires_at: null,
    derived_from: request.target_object_id,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: proposalId,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [
      {
        option_id: `memory_update_${proposalId}`,
        option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: timestamp
  });

  const created = await input.deps.proposalRepo.createProposalWithEvents(
    {
      proposal,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      target_object_kind: "memory_entry",
      proposed_changes: request.proposed_changes,
      proposed_change_summary: request.reason,
      created_at: timestamp,
      target_baseline_updated_at: targetBaselineUpdatedAt,
      source_delivery_ids: sourceDeliveryIds
    },
    buildProposalCreationEvents(proposal, context, sourceDeliveryIds),
    buildReviewerAssignment(input.deps, proposal.proposal_id, timestamp, proposal.expires_at)
  );
  await notifyResolvedEvents(input.deps, created.events);
  return { proposal_id: created.proposal.proposal_id, status: "created" };
}

async function reviewMemoryProposal(
  input: Readonly<{
    readonly deps: McpMemoryProposalWorkflowDependencies;
    readonly now: () => string;
    readonly generateObjectId: () => string;
  }>,
  request: SoulReviewMemoryProposalRequest,
  context: McpMemoryToolCallContext
): Promise<Readonly<{ proposal_id: string; resolution_state: Proposal["resolution_state"] }>> {
  const scopedProposal = await loadPendingScopedProposal(input.deps, request.proposal_id, context);
  const reviewerIdentity = resolveProposalReviewer(input.deps, scopedProposal, request, context);
  const reviewedAt = input.now();
  const toState =
    request.verdict === "accept"
      ? ProposalResolutionState.ACCEPTED
      : ProposalResolutionState.REJECTED;
  const acceptedMemoryUpdate =
    request.verdict === "accept"
      ? await prepareAcceptedProposalApply(
          input.deps,
          scopedProposal,
          context,
          input.now,
          input.generateObjectId
        )
      : undefined;
  const karmaMutation = buildProposalReviewKarmaMutation(
    input.deps,
    scopedProposal,
    request.verdict === "accept" ? "accept" : "reject",
    context
  );
  const resolved = await applyProposalReviewResolution(
    input.deps,
    scopedProposal,
    reviewerIdentity,
    reviewedAt,
    toState,
    buildProposalResolutionEvents(scopedProposal, context, reviewerIdentity, request, reviewedAt, toState),
    acceptedMemoryUpdate,
    buildProposalReviewResolutionOptions(
      reviewerIdentity,
      karmaMutation?.applySynchronousResolutionMutation
    )
  );
  karmaMutation?.afterCommit();
  await notifyResolvedEvents(input.deps, resolved.events);
  return {
    proposal_id: resolved.proposal.proposal_id,
    resolution_state: resolved.proposal.resolution_state
  };
}

async function listPendingProposals(
  input: Readonly<{
    readonly deps: McpMemoryProposalWorkflowDependencies;
    readonly now: () => string;
  }>,
  request: SoulListPendingProposalsRequest,
  context: McpMemoryToolCallContext
): Promise<Readonly<{
  readonly proposals: readonly Readonly<SoulPendingProposalSummary>[];
  readonly total_count: number;
}>> {
  const summaries = await input.deps.proposalRepo.findPendingSummaries(context.workspaceId, {
    since: request.since ?? null,
    limit: request.limit ?? 50,
    now: input.now()
  });
  return {
    proposals: summaries,
    total_count: summaries.length
  };
}

async function loadPendingScopedProposal(
  deps: McpMemoryProposalWorkflowDependencies,
  proposalId: string,
  context: McpMemoryToolCallContext
): Promise<NonNullable<Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>>> {
  const scopedProposal = await deps.proposalRepo.findScopedById(proposalId);
  if (scopedProposal === null) {
    throw createWorkflowError("NOT_FOUND", `Proposal not found: ${proposalId}`);
  }
  assertProposalContext(scopedProposal, context);
  if (scopedProposal.proposal.resolution_state !== ProposalResolutionState.PENDING) {
    throw createWorkflowError(
      "VALIDATION",
      `Proposal is already ${scopedProposal.proposal.resolution_state}`
    );
  }
  return scopedProposal;
}

function resolveProposalReviewer(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: NonNullable<Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>>,
  request: SoulReviewMemoryProposalRequest,
  context: McpMemoryToolCallContext
): string {
  assertReviewCallerIsAllowed(context, deps.reviewerIdentityBinding);
  const reviewerIdentity = resolveReviewerIdentity(request, deps.reviewerIdentityBinding);
  assertReviewerAssignment(scopedProposal, reviewerIdentity);
  return reviewerIdentity;
}

async function applyProposalReviewResolution(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: NonNullable<Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>>,
  reviewerIdentity: string,
  reviewedAt: string,
  toState: Proposal["resolution_state"],
  reviewEvents: readonly ProposalResolutionEventInput[],
  acceptedMemoryUpdate: Awaited<ReturnType<typeof prepareAcceptedProposalApply>> | undefined,
  options: ProposalReviewResolutionOptions
): Promise<Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly events: readonly EventLogEntry[];
}>> {
  try {
    if (acceptedMemoryUpdate === undefined) {
      return await deps.proposalRepo.updatePendingResolutionWithEvents(
        scopedProposal.proposal.proposal_id,
        toState,
        reviewedAt,
        reviewEvents,
        options
      );
    }
    if (acceptedMemoryUpdate.kind === "memory_update") {
      return await acceptProposalWithDurableMemoryUpdate(
        deps,
        scopedProposal.proposal.proposal_id,
        reviewedAt,
        reviewEvents,
        acceptedMemoryUpdate.memoryUpdate,
        options
      );
    }
    if (acceptedMemoryUpdate.kind === "path_relation_governance") {
      return await acceptProposalWithDurablePathRelationGovernance(
        deps,
        scopedProposal.proposal.proposal_id,
        reviewedAt,
        reviewEvents,
        acceptedMemoryUpdate.pathRelationGovernance,
        options
      );
    }
    return await acceptProposalWithDurableSynthesisCreate(
      deps,
      scopedProposal.proposal.proposal_id,
      reviewedAt,
      reviewEvents,
      acceptedMemoryUpdate.synthesisCreate,
      options
    );
  } catch (error) {
    throw normalizeResolutionError(error);
  }
}

function buildProposalReviewResolutionOptions(
  reviewerIdentity: string,
  applySynchronousResolutionMutation: (() => readonly ProposalResolutionEventInput[]) | undefined
): ProposalReviewResolutionOptions {
  return {
    reviewerIdentity,
    ...(applySynchronousResolutionMutation === undefined
      ? {}
      : { applySynchronousResolutionMutation })
  };
}

function buildProposalCreationEvents(
  proposal: Proposal,
  context: McpMemoryToolCallContext,
  sourceDeliveryIds: readonly string[] | null
): readonly ProposalCreationEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: context.agentTarget,
      payload_json: SoulProposalCreatedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        ...(sourceDeliveryIds === null ? {} : { source_delivery_ids: sourceDeliveryIds })
      })
    }
  ];
}

function buildReviewerAssignment(
  deps: McpMemoryProposalWorkflowDependencies,
  proposalId: string,
  timestamp: string,
  deadlineAt: string | null
): { readonly reviewerAssignment: {
  readonly proposal_id: string;
  readonly reviewer_identity: string;
  readonly assigned_at: string;
  readonly deadline_at: string | null;
  readonly escalation_after_ms: null;
} } | undefined {
  if (deps.reviewerIdentityBinding === undefined) {
    return undefined;
  }
  return {
    reviewerAssignment: {
      proposal_id: proposalId,
      reviewer_identity: deps.reviewerIdentityBinding.identity,
      assigned_at: timestamp,
      deadline_at: deadlineAt,
      escalation_after_ms: null
    }
  };
}

function buildProposalResolutionEvents(
  scopedProposal: NonNullable<Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>>,
  context: McpMemoryToolCallContext,
  reviewerIdentity: string,
  request: SoulReviewMemoryProposalRequest,
  reviewedAt: string,
  toState: Proposal["resolution_state"]
): readonly ProposalResolutionEventInput[] {
  const proposal = scopedProposal.proposal;
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: reviewerIdentity,
      payload_json: SoulReviewCreatedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: context.workspaceId,
        run_id: context.runId
      })
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: reviewerIdentity,
      payload_json: SoulReviewCompletedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        from_state: proposal.resolution_state,
        to_state: toState,
        reason_code: request.reason ?? request.verdict,
        caused_by: TransitionCausedBy.REVIEW,
        evidence_refs: null,
        occurred_at: reviewedAt
      })
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: reviewerIdentity,
      payload_json: SoulProposalResolvedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        from_state: proposal.resolution_state,
        to_state: toState,
        reason_code: request.reason ?? request.verdict,
        caused_by: TransitionCausedBy.REVIEW,
        evidence_refs: null,
        occurred_at: reviewedAt,
        ...(scopedProposal.source_delivery_ids === null ||
        scopedProposal.source_delivery_ids === undefined
          ? {}
          : { source_delivery_ids: scopedProposal.source_delivery_ids })
      })
    }
  ];
}

async function notifyResolvedEvents(
  deps: McpMemoryProposalWorkflowDependencies,
  events: readonly EventLogEntry[]
): Promise<void> {
  for (const event of events) {
    await deps.runtimeNotifier.notifyEntry(event);
  }
}

async function readProposalTargetBaseline(
  deps: McpMemoryProposalWorkflowDependencies,
  targetObjectId: string,
  workspaceId: string
): Promise<string | null> {
  const memoryService = deps.memoryService;
  if (memoryService === undefined) {
    return null;
  }
  const scopedTarget = await memoryService.findByIdScoped(targetObjectId, workspaceId);
  if (scopedTarget === null) {
    throw createWorkflowError(
      "NOT_FOUND",
      `Target memory object not found in workspace: ${targetObjectId}`
    );
  }
  return scopedTarget.updated_at ?? null;
}

async function validateSourceDeliveryIds(
  deps: McpMemoryProposalWorkflowDependencies,
  sourceDeliveryIds: readonly string[] | null,
  context: McpMemoryToolCallContext
): Promise<void> {
  if (sourceDeliveryIds === null) {
    return;
  }
  if (deps.sourceDeliveryAnchorValidator === undefined) {
    throw new SourceDeliveryAnchorValidationError(
      "source_delivery_ids require a source delivery anchor validator."
    );
  }
  await deps.sourceDeliveryAnchorValidator.validate(sourceDeliveryIds, context);
}
