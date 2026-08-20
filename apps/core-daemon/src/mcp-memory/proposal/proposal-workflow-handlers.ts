import {
  ProposalResolutionState,
  type EventLogEntry,
  type Proposal,
  type SoulListPendingProposalsRequest,
  type SoulPendingProposalSummary,
  type SoulProposeMemoryUpdateRequest,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../tool/tool-handler-types.js";
import {
  assertProposalContext,
  assertReviewCallerIsAllowed,
  assertReviewerAssignment,
  createWorkflowError,
  resolveReviewerIdentity
} from "./proposal-workflow-reviewer.js";
import type { McpMemoryProposalWorkflowDependencies } from "./proposal-workflow.js";
import { buildProposalReviewKarmaMutation } from "./proposal-review-karma.js";
import { prepareMemoryProposalOperation } from "./phases/request-operation.js";
import { buildMemoryProposal } from "./phases/proposal-construction.js";
import { combineResolutionMutations } from "./phases/resolution-mutation.js";
import {
  buildProposalCreationEvents,
  buildProposalResolutionEvents
} from "./phases/proposal-events.js";
import {
  applyProposalReviewResolution,
  buildProposalReviewResolutionOptions,
  prepareAcceptedReviewApply
} from "./phases/review-resolution.js";
import {
  SourceDeliveryAnchorValidationError
} from "./proposal-workflow-types.js";

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
  const proposalMutation = await prepareMemoryProposalOperation(
    request,
    async () => await readProposalTargetBaseline(
      input.deps,
      request.target_object_id,
      context.workspaceId
    ),
    (message) => createWorkflowError("VALIDATION", message)
  );
  const proposal = buildMemoryProposal({
    proposalId,
    timestamp,
    request,
    context,
    mutation: proposalMutation
  });

  const created = await input.deps.proposalRepo.createProposalWithEvents(
    {
      proposal,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      proposal_operation: proposalMutation.operation,
      target_object_kind: proposalMutation.targetObjectKind,
      proposed_changes: proposalMutation.proposedChanges,
      proposed_change_summary: request.reason,
      created_at: timestamp,
      target_baseline_updated_at: proposalMutation.targetBaselineUpdatedAt,
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
  const resolved = await resolveProposalReview(
    input, scopedProposal, request, context, reviewerIdentity, reviewedAt
  );
  return await completeProposalReview(input.deps, resolved.result, resolved.afterCommit);
}

async function resolveProposalReview(
  input: Readonly<{
    readonly deps: McpMemoryProposalWorkflowDependencies;
    readonly now: () => string;
    readonly generateObjectId: () => string;
  }>,
  scopedProposal: Awaited<ReturnType<typeof loadPendingScopedProposal>>,
  request: SoulReviewMemoryProposalRequest,
  context: McpMemoryToolCallContext,
  reviewerIdentity: string,
  reviewedAt: string
) {
  const toState = reviewResolutionState(request);
  const acceptedMemoryUpdate = await prepareAcceptedReviewApply({
    deps: input.deps,
    scopedProposal,
    request,
    context,
    now: input.now,
    generateObjectId: input.generateObjectId
  });
  const karmaMutation = buildProposalReviewKarmaMutation(
    input.deps,
    scopedProposal,
    request.verdict === "accept" ? "accept" : "reject",
    context
  );
  const result = await applyProposalReviewResolution({
    deps: input.deps,
    scopedProposal,
    reviewedAt,
    toState,
    reviewEvents: buildProposalResolutionEvents({
      scopedProposal,
      context,
      reviewerIdentity,
      request,
      reviewedAt,
      toState
    }),
    acceptedApply: acceptedMemoryUpdate,
    options: buildProposalReviewResolutionOptions(
      reviewerIdentity,
      combineResolutionMutations(
        karmaMutation?.applySynchronousResolutionMutation
      )
    )
  });
  return { result, afterCommit: karmaMutation?.afterCommit };
}

function reviewResolutionState(
  request: SoulReviewMemoryProposalRequest
): Proposal["resolution_state"] {
  return request.verdict === "accept"
    ? ProposalResolutionState.ACCEPTED
    : ProposalResolutionState.REJECTED;
}

async function completeProposalReview(
  deps: McpMemoryProposalWorkflowDependencies,
  resolved: Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }>,
  afterCommit: (() => void) | undefined
): Promise<Readonly<{ proposal_id: string; resolution_state: Proposal["resolution_state"] }>> {
  afterCommit?.();
  await notifyResolvedEvents(deps, resolved.events);
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
