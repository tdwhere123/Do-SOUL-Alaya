import {
  EdgeProposalStatus,
  GraphAuditorEventType,
  SoulGraphEdgeProposalCreatedPayloadSchema,
  SoulGraphEdgeProposalPathMintFailedPayloadSchema,
  SoulGraphEdgeProposalReviewedPayloadSchema,
  type EdgeProposal
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";
import type { EdgeProposalCreateEventInput } from "./edge-proposal-service-ports.js";

export function buildProposalCreatedEvent(proposal: EdgeProposalCreateEventInput): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: proposal.trigger_source,
    payload_json: SoulGraphEdgeProposalCreatedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      source_memory_id: proposal.source_memory_id,
      target_memory_id: proposal.target_memory_id,
      edge_type: proposal.edge_type,
      trigger_source: proposal.trigger_source,
      confidence: proposal.confidence,
      reason: proposal.reason,
      source_signal_id: proposal.source_signal_id,
      workspace_id: proposal.workspace_id,
      occurred_at: proposal.created_at
    })
  };
}

export function buildProposalReviewedEvent(
  proposal: EdgeProposal,
  status:
    | typeof EdgeProposalStatus.ACCEPTED
    | typeof EdgeProposalStatus.REJECTED
    | typeof EdgeProposalStatus.EXPIRED
    | typeof EdgeProposalStatus.AUTO_ACCEPTED,
  reviewerIdentity: string,
  reviewReason: string | null,
  reviewedAt: string
): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: reviewerIdentity,
    payload_json: SoulGraphEdgeProposalReviewedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      status,
      reviewer_identity: reviewerIdentity,
      review_reason: reviewReason,
      workspace_id: proposal.workspace_id,
      occurred_at: reviewedAt
    })
  };
}

// invariant: BoundedReasonSchema bounds review-reason-class strings; keep the
// failure detail within the same bound so the payload parse never rejects a
// long underlying error message at the durable-emission boundary.
const PATH_MINT_FAILURE_DETAIL_MAX = 500;

function describeMintFailureCause(cause: unknown): string | null {
  if (cause === null || cause === undefined) {
    return null;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, PATH_MINT_FAILURE_DETAIL_MAX);
}

export function buildPathMintFailedEvent(
  proposal: EdgeProposal,
  reviewerIdentity: string,
  failureKind: "submit_returned_false" | "submit_threw",
  cause: unknown,
  occurredAt: string
): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: reviewerIdentity,
    payload_json: SoulGraphEdgeProposalPathMintFailedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      source_memory_id: proposal.source_memory_id,
      target_memory_id: proposal.target_memory_id,
      edge_type: proposal.edge_type,
      reviewer_identity: reviewerIdentity,
      failure_kind: failureKind,
      failure_detail: describeMintFailureCause(cause),
      workspace_id: proposal.workspace_id,
      occurred_at: occurredAt
    })
  };
}
