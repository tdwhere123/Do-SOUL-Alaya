import {
  EDGE_TYPE_RECALL_MODEL,
  EdgeProposalStatus,
  type EdgeProposal
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../../runtime/event-publisher.js";
import type { PathCandidateSink } from "../producers/path-candidate-sink.js";
import type { PathFailureHealthInboxPort } from "../path-relations/path-failure-health-inbox.js";
import type { PathMintOutcome } from "./path-relation-proposal-service.js";
import { buildPathMintFailedEvent } from "./edge-proposal-events.js";
import {
  ACCEPT_PATH_STRENGTH_FLOOR,
  PATH_MINT_FAILED_REVIEW_REASON,
  PATH_MINT_SUPERSEDED_REVIEW_REASON,
  PATH_MINT_SUPERSEDED_REVIEWER_IDENTITY,
  edgeTypeToRecallBiasSign,
  type EdgeProposalRepoPort
} from "./edge-proposal-service-ports.js";

export interface EdgeProposalMinterDependencies {
  readonly proposalRepo: EdgeProposalRepoPort;
  readonly pathCandidatePort: PathCandidateSink;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  readonly healthInboxPort?: PathFailureHealthInboxPort;
  readonly now: () => string;
}

type AcceptedStatus = typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED;

// Compensates a failed mint with a durable mint-failed audit + review-row rollback.
export class EdgeProposalMinter {
  public constructor(private readonly deps: EdgeProposalMinterDependencies) {}

  public async mintAcceptedPath(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    acceptedStatus: AcceptedStatus
  ): Promise<PathMintOutcome> {
    const sign = edgeTypeToRecallBiasSign(proposal.edge_type);
    const magnitude = Math.abs(EDGE_TYPE_RECALL_MODEL[proposal.edge_type].contribution_weight);
    const governanceClass =
      sign < 0 && acceptedStatus === EdgeProposalStatus.AUTO_ACCEPTED
        ? "attention_only"
        : "recall_allowed";
    let outcome: PathMintOutcome;
    try {
      outcome = await this.deps.pathCandidatePort.submitCandidate({
        workspaceId: proposal.workspace_id,
        sourceAnchor: { kind: "object", object_id: proposal.source_memory_id },
        targetAnchor: { kind: "object", object_id: proposal.target_memory_id },
        relationKind: proposal.edge_type,
        initialStrength: Math.max(ACCEPT_PATH_STRENGTH_FLOOR, magnitude),
        governanceClass,
        evidenceBasis: [`edge_proposal_accept:${proposal.proposal_id}`],
        recallBiasSign: sign,
        recallBiasMagnitude: magnitude,
        why: [`edge proposal ${proposal.proposal_id} accepted by ${reviewerIdentity}`],
        runId: proposal.run_id
      });
    } catch (mintError) {
      // invariant: submitCandidate is contracted to catch its own materialize
      // errors and return a discriminated outcome; a thrown error is classed
      // transient ("failed", never a DECIDED rejection) and so reconciles to
      // pending for operator retry.
      await this.handleMintFailure(proposal, acceptedStatus, reviewerIdentity, "submit_threw", "failed", mintError);
      return "failed";
    }
    if (outcome === "failed" || outcome === "rejected") {
      await this.handleMintFailure(proposal, acceptedStatus, reviewerIdentity, "submit_returned_false", outcome);
    }
    return outcome;
  }

  private async handleMintFailure(
    proposal: EdgeProposal,
    acceptedStatus: AcceptedStatus,
    reviewerIdentity: string,
    failureKind: "submit_returned_false" | "submit_threw",
    mintOutcome: "failed" | "rejected",
    cause: unknown = null
  ): Promise<void> {
    const reviewedAt = this.deps.now();
    const toStatus = mintOutcome === "rejected" ? EdgeProposalStatus.REJECTED : EdgeProposalStatus.PENDING;
    const reviewReason =
      mintOutcome === "rejected"
        ? `auto-rejected: owed path mint permanently refused (${PATH_MINT_FAILED_REVIEW_REASON})`
        : null;
    await this.deps.eventPublisher.appendManyWithMutation(
      [buildPathMintFailedEvent(proposal, reviewerIdentity, failureKind, cause, reviewedAt)],
      () => {
        this.deps.proposalRepo.reconcileAfterMintFailure({
          proposalId: proposal.proposal_id,
          fromStatus: acceptedStatus,
          toStatus,
          reviewerIdentity: mintOutcome === "rejected" ? reviewerIdentity : null,
          reviewReason,
          reviewedAt,
          // invariant: only the revert-to-pending path can collide with the
          // pending-unique index; the repo uses these to move the row to
          // terminal rejected instead of rolling back this audit transaction.
          supersededReviewerIdentity: PATH_MINT_SUPERSEDED_REVIEWER_IDENTITY,
          supersededReviewReason: PATH_MINT_SUPERSEDED_REVIEW_REASON
        });
      }
    );
    // invariant: D-EDGEAUDIT. The owed-path mint failure is now durably audited;
    // ALSO surface it to the operator-triage inbox (best-effort, after the
    // atomic audit+reconcile committed) so it is visible without a forensic
    // EventLog scan. target_object_id = the proposal's source memory whose
    // durable topology failed to form. A port throw must not break the accept.
    await this.recordPathFailureToInbox(proposal.workspace_id, proposal.source_memory_id);
  }

  private async recordPathFailureToInbox(workspaceId: string, targetObjectId: string): Promise<void> {
    const port = this.deps.healthInboxPort;
    if (port === undefined) {
      return;
    }
    try {
      await port.recordPathRelationFailure({
        workspaceId,
        targetObjectId,
        observedAt: this.deps.now()
      });
    } catch (error) {
      // best-effort projection: never break the accept flow, but surface the swallow.
      process.emitWarning("[EdgeProposalMinter] path-failure health-inbox write failed", {
        code: "ALAYA_PATH_FAILURE_INBOX_WRITE_FAILED",
        detail: JSON.stringify({
          workspace_id: workspaceId,
          target_object_id: targetObjectId,
          error: error instanceof Error ? error.message : String(error)
        })
      });
    }
  }
}
