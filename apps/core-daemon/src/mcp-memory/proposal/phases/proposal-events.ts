import {
  MemoryGovernanceEventType,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulReviewCompletedPayloadSchema,
  SoulReviewCreatedPayloadSchema,
  TransitionCausedBy,
  type MemoryProposalOperation,
  type Proposal,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "../../tool/tool-handler-types.js";
import type {
  ProposalCreationEventInput,
  ProposalResolutionEventInput
} from "../proposal-workflow-types.js";

type ScopedProposal = Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly proposal_operation?: MemoryProposalOperation | null;
  readonly source_delivery_ids?: readonly string[] | null;
}>;

export function buildProposalCreationEvents(
  proposal: Proposal,
  context: McpMemoryToolCallContext,
  sourceDeliveryIds: readonly string[] | null
): readonly ProposalCreationEventInput[] {
  return [{
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
  }];
}

export function buildProposalResolutionEvents(input: Readonly<{
  readonly scopedProposal: ScopedProposal;
  readonly context: McpMemoryToolCallContext;
  readonly reviewerIdentity: string;
  readonly request: SoulReviewMemoryProposalRequest;
  readonly reviewedAt: string;
  readonly toState: Proposal["resolution_state"];
}>): readonly ProposalResolutionEventInput[] {
  const proposal = input.scopedProposal.proposal;
  const transition = buildTransitionPayload(input);
  return [
    buildReviewCreatedEvent(proposal, input.context, input.reviewerIdentity),
    buildReviewCompletedEvent(proposal, input.context, input.reviewerIdentity, transition),
    buildProposalResolvedEvent(proposal, input, transition)
  ];
}

function buildTransitionPayload(input: Readonly<{
  readonly scopedProposal: ScopedProposal;
  readonly request: SoulReviewMemoryProposalRequest;
  readonly reviewedAt: string;
  readonly toState: Proposal["resolution_state"];
}>): Readonly<Record<string, unknown>> {
  const proposal = input.scopedProposal.proposal;
  const reasonCode = input.scopedProposal.proposal_operation === "privacy_erase"
    ? `privacy_erase_${input.request.verdict === "accept" ? "accepted" : "rejected"}`
    : input.request.reason ?? input.request.verdict;
  return {
    object_id: proposal.runtime_id,
    object_kind: proposal.object_kind,
    from_state: proposal.resolution_state,
    to_state: input.toState,
    reason_code: reasonCode,
    caused_by: TransitionCausedBy.REVIEW,
    evidence_refs: null,
    occurred_at: input.reviewedAt
  };
}

function buildReviewCreatedEvent(
  proposal: Proposal,
  context: McpMemoryToolCallContext,
  reviewerIdentity: string
): ProposalResolutionEventInput {
  return eventEnvelope(proposal, context, reviewerIdentity, {
    event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
    payload_json: SoulReviewCreatedPayloadSchema.parse({
      object_id: proposal.runtime_id,
      object_kind: proposal.object_kind,
      workspace_id: context.workspaceId,
      run_id: context.runId
    })
  });
}

function buildReviewCompletedEvent(
  proposal: Proposal,
  context: McpMemoryToolCallContext,
  reviewerIdentity: string,
  transition: Readonly<Record<string, unknown>>
): ProposalResolutionEventInput {
  return eventEnvelope(proposal, context, reviewerIdentity, {
    event_type: MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
    payload_json: SoulReviewCompletedPayloadSchema.parse({
      ...transition,
      workspace_id: context.workspaceId,
      run_id: context.runId
    })
  });
}

function buildProposalResolvedEvent(
  proposal: Proposal,
  input: Readonly<{
    readonly scopedProposal: ScopedProposal;
    readonly context: McpMemoryToolCallContext;
    readonly reviewerIdentity: string;
  }>,
  transition: Readonly<Record<string, unknown>>
): ProposalResolutionEventInput {
  const sourceIds = input.scopedProposal.source_delivery_ids;
  return eventEnvelope(proposal, input.context, input.reviewerIdentity, {
    event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
    payload_json: SoulProposalResolvedPayloadSchema.parse({
      ...transition,
      workspace_id: input.context.workspaceId,
      run_id: input.context.runId,
      ...(sourceIds == null ? {} : { source_delivery_ids: sourceIds })
    })
  });
}

function eventEnvelope(
  proposal: Proposal,
  context: McpMemoryToolCallContext,
  reviewerIdentity: string,
  event: Pick<ProposalResolutionEventInput, "event_type" | "payload_json">
): ProposalResolutionEventInput {
  return {
    ...event,
    entity_type: "proposal",
    entity_id: proposal.proposal_id,
    workspace_id: context.workspaceId,
    run_id: context.runId,
    caused_by: reviewerIdentity
  };
}
