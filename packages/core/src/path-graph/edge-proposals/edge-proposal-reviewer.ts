import {
  EdgeProposalStatus,
  type EdgeProposal
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { EventPublisher } from "../../runtime/event-publisher.js";
import { buildProposalReviewedEvent } from "./edge-proposal-events.js";
import type { EdgeProposalMinter } from "./edge-proposal-minter.js";
import type {
  EdgeProposalMemoryRepoPort,
  EdgeProposalRepoPort
} from "./edge-proposal-service-ports.js";

export interface EdgeProposalReviewerDependencies {
  readonly memoryRepo: EdgeProposalMemoryRepoPort;
  readonly proposalRepo: EdgeProposalRepoPort;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  readonly minter: EdgeProposalMinter;
  readonly now: () => string;
}

type AcceptedStatus = typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED;

// Writes the reviewed audit + review row atomically before the owed-path mint hand-off.
export class EdgeProposalReviewer {
  public constructor(private readonly deps: EdgeProposalReviewerDependencies) {}

  public async acceptProposal(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    reviewReason: string | null,
    reviewedAt: string,
    acceptedStatus: AcceptedStatus
  ): Promise<EdgeProposal> {
    await this.requireMemoryInWorkspace(proposal.source_memory_id, "Source", proposal.workspace_id);
    await this.requireMemoryInWorkspace(proposal.target_memory_id, "Target", proposal.workspace_id);

    let reviewed: EdgeProposal = proposal;
    await this.deps.eventPublisher.appendManyWithMutation(
      [buildProposalReviewedEvent(proposal, acceptedStatus, reviewerIdentity, reviewReason, reviewedAt)],
      () => {
        reviewed = this.deps.proposalRepo.updateReview({
          proposalId: proposal.proposal_id,
          status: acceptedStatus,
          reviewerIdentity,
          reviewReason,
          reviewedAt
        });
      }
    );

    // invariant: under the single-plane model the minted path is the ONLY
    // durable landing for an accepted proposal. applied / already_present mean
    // the owed path exists, so the accepted review row stands. A "failed" or
    // "rejected" outcome means the review row committed ACCEPTED/AUTO_ACCEPTED
    // with no path, which must never be silent: handleMintFailure emits a
    // durable SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED record keyed on
    // proposal_id AND compensates the review row OUT of the
    // accepted-without-path state, and the OBLIGATION_VIOLATION throw stays
    // loud at call time.
    const outcome = await this.deps.minter.mintAcceptedPath(proposal, reviewerIdentity, acceptedStatus);
    if (outcome === "failed" || outcome === "rejected") {
      throw new CoreError(
        "OBLIGATION_VIOLATION",
        `Edge proposal accepted but path mint failed: ${proposal.proposal_id}`
      );
    }
    return reviewed;
  }

  public async rejectProposal(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    reviewReason: string | null,
    reviewedAt: string
  ): Promise<void> {
    await this.deps.eventPublisher.appendManyWithMutation(
      [buildProposalReviewedEvent(proposal, EdgeProposalStatus.REJECTED, reviewerIdentity, reviewReason, reviewedAt)],
      () => {
        this.deps.proposalRepo.updateReview({
          proposalId: proposal.proposal_id,
          status: EdgeProposalStatus.REJECTED,
          reviewerIdentity,
          reviewReason,
          reviewedAt
        });
      }
    );
  }

  public async requireMemoryInWorkspace(memoryId: string, label: string, workspaceId: string): Promise<void> {
    const memory = await this.deps.memoryRepo.findById(memoryId);
    if (memory === null) {
      throw new CoreError("NOT_FOUND", `${label} memory not found: ${memoryId}`);
    }
    if (memory.workspace_id !== workspaceId) {
      throw new CoreError("VALIDATION", `${label} memory does not belong to workspace ${workspaceId}: ${memoryId}`);
    }
  }
}
