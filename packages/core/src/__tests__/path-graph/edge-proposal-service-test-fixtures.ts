import { vi } from "vitest";
import { requireAt } from "../helpers/defined.js";
import { EdgeProposalStatus, type EdgeProposal } from "@do-soul/alaya-protocol";
import { EdgeProposalService, type EdgeProposalRepoPort } from "../../path-graph/edge-proposals/edge-proposal-service.js";
import type { EventPublisher } from "../../runtime/event-publisher.js";
import type { PathCandidateSink } from "../../path-graph/producers/path-candidate-sink.js";
import type { PathMintOutcome } from "../../path-graph/edge-proposals/path-relation-proposal-service.js";

export function createProposalRepo(options: {
  readonly beforeUpdateReview?: (proposalId: string) => void;
} = {}): EdgeProposalRepoPort & {
  findById(proposalId: string): EdgeProposal | null;
  forceStatus(proposalId: string, status: EdgeProposal["status"]): void;
} {
  const proposals: EdgeProposal[] = [];
  return {
    create(input) {
      const proposal: EdgeProposal = {
        ...input,
        status: EdgeProposalStatus.PENDING,
        reviewer_identity: null,
        review_reason: null,
        updated_at: input.created_at
      };
      proposals.push(proposal);
      return proposal;
    },
    findById(proposalId: string) {
      return proposals.find((proposal) => proposal.proposal_id === proposalId) ?? null;
    },
    forceStatus(proposalId: string, status: EdgeProposal["status"]) {
      const index = proposals.findIndex((proposal) => proposal.proposal_id === proposalId);
      if (index !== -1) {
        const existing = requireAt(proposals, index);
        proposals[index] = { ...existing, status };
      }
    },
    findPendingDuplicate(input) {
      return proposals.find((proposal) =>
        proposal.workspace_id === input.workspaceId &&
        proposal.source_memory_id === input.sourceMemoryId &&
        proposal.target_memory_id === input.targetMemoryId &&
        proposal.edge_type === input.edgeType &&
        proposal.status === EdgeProposalStatus.PENDING
      ) ?? null;
    },
    listAcceptedAwaitingPath(workspaceId, limit) {
      return proposals
        .filter(
          (proposal) =>
            proposal.workspace_id === workspaceId &&
            (proposal.status === EdgeProposalStatus.ACCEPTED ||
              proposal.status === EdgeProposalStatus.AUTO_ACCEPTED)
        )
        .slice(0, limit);
    },
    listPending(workspaceId, filter = {}) {
      return proposals.filter((proposal) => {
        if (proposal.workspace_id !== workspaceId || proposal.status !== EdgeProposalStatus.PENDING) {
          return false;
        }
        if (filter.proposal_ids !== undefined && !filter.proposal_ids.includes(proposal.proposal_id)) {
          return false;
        }
        if (filter.edge_type !== undefined && proposal.edge_type !== filter.edge_type) {
          return false;
        }
        if (filter.trigger_source !== undefined && proposal.trigger_source !== filter.trigger_source) {
          return false;
        }
        if (filter.min_confidence !== undefined && proposal.confidence < filter.min_confidence) {
          return false;
        }
        return true;
      });
    },
    listExpiredPending(workspaceId, nowIso, limit) {
      return proposals
        .filter(
          (proposal) =>
            proposal.workspace_id === workspaceId &&
            proposal.status === EdgeProposalStatus.PENDING &&
            proposal.expires_at !== null &&
            proposal.expires_at < nowIso
        )
        .slice(0, limit);
    },
    updateReview(input) {
      options.beforeUpdateReview?.(input.proposalId);
      const index = proposals.findIndex((proposal) => proposal.proposal_id === input.proposalId);
      if (index === -1) {
        throw new Error(`missing proposal ${input.proposalId}`);
      }
      const pending = requireAt(proposals, index);
      if (pending.status !== EdgeProposalStatus.PENDING) {
        throw new Error(`Edge proposal is not pending: ${input.proposalId}`);
      }
      const updated: EdgeProposal = {
        ...pending,
        status: input.status,
        reviewer_identity: input.reviewerIdentity,
        review_reason: input.reviewReason,
        updated_at: input.reviewedAt
      };
      proposals[index] = updated;
      return updated;
    },
    // CAS-gated on fromStatus, mirroring the SQLite WHERE status = ? guard.
    // Mirrors the repo's pending-unique collision fallback: when a revert to
    // pending would duplicate an existing pending row for the same tuple, the
    // row is moved to terminal rejected (superseded) instead, so the audit
    // transaction still commits. see also: edge-proposal-repo.ts.
    reconcileAfterMintFailure(input) {
      const index = proposals.findIndex((proposal) => proposal.proposal_id === input.proposalId);
      if (index === -1) {
        throw new Error(`missing proposal ${input.proposalId}`);
      }
      const subject = requireAt(proposals, index);
      if (subject.status !== input.fromStatus) {
        throw new Error(`Edge proposal is not in ${input.fromStatus}: ${input.proposalId}`);
      }
      const collidesWithPendingDuplicate =
        input.toStatus === EdgeProposalStatus.PENDING &&
        proposals.some(
          (proposal) =>
            proposal.proposal_id !== subject.proposal_id &&
            proposal.workspace_id === subject.workspace_id &&
            proposal.source_memory_id === subject.source_memory_id &&
            proposal.target_memory_id === subject.target_memory_id &&
            proposal.edge_type === subject.edge_type &&
            proposal.status === EdgeProposalStatus.PENDING
        );
      const reconciled: EdgeProposal = collidesWithPendingDuplicate
        ? {
            ...subject,
            status: EdgeProposalStatus.REJECTED,
            reviewer_identity: input.supersededReviewerIdentity ?? null,
            review_reason: input.supersededReviewReason ?? null,
            updated_at: input.reviewedAt
          }
        : {
            ...subject,
            status: input.toStatus,
            reviewer_identity: input.reviewerIdentity,
            review_reason: input.reviewReason,
            updated_at: input.reviewedAt
          };
      proposals[index] = reconciled;
      return reconciled;
    }
  };
}

export function createPathCandidatePort(): PathCandidateSink & {
  submitCandidate: ReturnType<typeof vi.fn>;
} {
  return {
    submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied")
  };
}

export function createEventPublisher() {
  const appendManyWithMutationImpl: Pick<EventPublisher, "appendManyWithMutation">["appendManyWithMutation"] =
    async (_events, mutate) => mutate([]);
  // appendManyWithMutation is generic over the mutate result; vi.fn cannot carry a
  // generic call signature, so the spy is re-asserted onto the structural port type.
  const appendManyWithMutation = vi.fn(appendManyWithMutationImpl);
  return {
    appendManyWithMutation: appendManyWithMutation as unknown as EventPublisher["appendManyWithMutation"] &
      typeof appendManyWithMutation
  };
}

export function createMemoryRepo(overrides: Record<string, string> = {}) {
  const workspaces = new Map<string, string>([
    ["memory-a", "workspace-1"],
    ["memory-b", "workspace-1"],
    ["memory-c", "workspace-1"],
    ...Object.entries(overrides)
  ]);
  return {
    findById: vi.fn(async (objectId: string) => {
      const workspaceId = workspaces.get(objectId);
      return workspaceId === undefined ? null : { object_id: objectId, workspace_id: workspaceId };
    })
  };
}

export function createIdGenerator(): () => string {
  let counter = 0;
  return () => `proposal-${++counter}`;
}

export function createAutoAcceptHarness() {
  const repo = createProposalRepo();
  const pathCandidatePort = createPathCandidatePort();
  const eventPublisher = createEventPublisher();
  const service = new EdgeProposalService({
    memoryRepo: createMemoryRepo(),
    proposalRepo: repo,
    pathCandidatePort,
    eventPublisher,
    generateId: createIdGenerator(),
    now: () => "2026-05-24T00:00:00.000Z"
  });
  return { service, repo, pathCandidatePort, eventPublisher };
}
