import { describe, expect, it, vi } from "vitest";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  type EdgeProposal,
  type MemoryGraphEdge
} from "@do-soul/alaya-protocol";
import {
  EdgeProposalService,
  type EdgeProposalRepoPort
} from "../edge-proposal-service.js";
import type { EventPublisher } from "../event-publisher.js";

describe("EdgeProposalService", () => {
  it("creates a pending proposal without writing a durable graph edge", async () => {
    const repo = createProposalRepo();
    const graphPort = createGraphPort();
    const eventPublisher = createEventPublisher();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort,
      eventPublisher,
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });

    const proposal = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      reason: "report_context_usage used-memory cross-link"
    });

    expect(proposal).toMatchObject({
      proposal_id: "edge_prop_proposal-1",
      workspace_id: "workspace-1",
      source_memory_id: "memory-a",
      target_memory_id: "memory-b",
      edge_type: "recalls",
      trigger_source: "recall_cross_link",
      status: "pending"
    });
    expect(graphPort.create).not.toHaveBeenCalled();
    expect(eventPublisher.appendManyWithMutation).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          event_type: "soul.graph.edge_proposal_created",
          entity_id: "edge_prop_proposal-1"
        })
      ],
      expect.any(Function)
    );
  });

  it("accept creates a graph edge and reject does not", async () => {
    const repo = createProposalRepo();
    const graphPort = createGraphPort();
    const eventPublisher = createEventPublisher();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort,
      eventPublisher,
      generateId: createIdGenerator(),
      now: () => "2026-05-24T00:00:00.000Z"
    });

    const accepted = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });
    const rejected = await service.proposeEdge({
      sourceMemoryId: "memory-b",
      targetMemoryId: "memory-c",
      edgeType: "contradicts",
      workspaceId: "workspace-1"
    });

    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [accepted.proposal_id] },
        reason: "reviewed",
        reviewerIdentity: "user:reviewer"
      })
    ).resolves.toMatchObject({ accepted_count: 1, rejected_count: 0 });
    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "reject",
        filter: { proposal_ids: [rejected.proposal_id] },
        reason: "not useful",
        reviewerIdentity: "user:reviewer"
      })
    ).resolves.toMatchObject({ accepted_count: 0, rejected_count: 1 });

    expect(graphPort.create).toHaveBeenCalledTimes(1);
    expect(graphPort.create).toHaveBeenCalledWith(expect.objectContaining({
      source_memory_id: "memory-a",
      target_memory_id: "memory-b",
      edge_type: "recalls",
      workspace_id: "workspace-1"
    }));
    const reviewEventBatches = eventPublisher.appendManyWithMutation.mock.calls
      .map((call) => call[0])
      .filter((events) => events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed"));
    expect(reviewEventBatches).toEqual([
      [
        expect.objectContaining({ event_type: "soul.graph.edge_proposal_reviewed" }),
        expect.objectContaining({ event_type: "soul.graph.edge_created" })
      ],
      [
        expect.objectContaining({ event_type: "soul.graph.edge_proposal_reviewed" })
      ]
    ]);
    expect(repo.findById(accepted.proposal_id)?.status).toBe(EdgeProposalStatus.ACCEPTED);
    expect(repo.findById(rejected.proposal_id)?.status).toBe(EdgeProposalStatus.REJECTED);
  });

  it("does not create a graph edge when the pending review CAS loses the race", async () => {
    const repo = createProposalRepo({
      beforeUpdateReview: (proposalId) => {
        repo.forceStatus(proposalId, EdgeProposalStatus.REJECTED);
      }
    });
    const graphPort = createGraphPort();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort,
      eventPublisher: createEventPublisher(),
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });
    const proposal = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });

    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [proposal.proposal_id] },
        reason: "stale review",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toThrow("Edge proposal is not pending");
    expect(graphPort.create).not.toHaveBeenCalled();
  });

  it("fails closed when explicit proposal ids are no longer pending", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort: createGraphPort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });
    const proposal = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });
    await service.batchReview({
      workspaceId: "workspace-1",
      verdict: "reject",
      filter: { proposal_ids: [proposal.proposal_id] },
      reason: "first decision wins",
      reviewerIdentity: "user:reviewer"
    });

    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [proposal.proposal_id] },
        reason: "late accept",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: `Edge proposal is not pending or does not match review filter: ${proposal.proposal_id}`
    });
  });

  it("clamps MCP explicit proposal confidence to the agent self-report ceiling", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort: createGraphPort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });

    await service.proposeExplicitEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      confidence: 1,
      reason: "agent asserted high confidence",
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(repo.findById("edge_prop_proposal-1")?.confidence).toBe(0.5);
  });

  // invariant: clamp lives in proposeEdge core, not the surface
  // wrapper. Any future caller that bypasses proposeExplicitEdge and
  // calls proposeEdge directly with triggerSource: EXPLICIT must still
  // be clamped to the 0.5 agent self-report ceiling.
  it("clamps EXPLICIT-triggered proposeEdge confidence to 0.5 even when called directly", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort: createGraphPort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });

    await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerSource: EdgeProposalTriggerSource.EXPLICIT,
      confidence: 0.9,
      reason: "future direct caller bypassing proposeExplicitEdge"
    });

    expect(repo.findById("edge_prop_proposal-1")?.confidence).toBe(0.5);
  });

  // Non-EXPLICIT trigger sources are produced by system code paths
  // (system / conflict_detection / recall_cross_link / bench_seed)
  // where the confidence is computed from evidence, not self-reported
  // by an agent — these must NOT be clamped to 0.5.
  it("does not clamp non-EXPLICIT proposeEdge confidence", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      graphPort: createGraphPort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "proposal-1",
      now: () => "2026-05-24T00:00:00.000Z"
    });

    await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      confidence: 0.85,
      reason: "system-computed evidence weight"
    });

    expect(repo.findById("edge_prop_proposal-1")?.confidence).toBe(0.85);
  });

  it("rejects cross-workspace endpoints before proposing", async () => {
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo({ "memory-b": "workspace-2" }),
      proposalRepo: createProposalRepo(),
      graphPort: createGraphPort(),
      eventPublisher: createEventPublisher()
    });

    await expect(
      service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Target memory does not belong to workspace workspace-1: memory-b"
    });
  });
});

function createProposalRepo(options: {
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
        proposals[index] = { ...proposals[index], status };
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
    updateReview(input) {
      options.beforeUpdateReview?.(input.proposalId);
      const index = proposals.findIndex((proposal) => proposal.proposal_id === input.proposalId);
      if (index === -1) {
        throw new Error(`missing proposal ${input.proposalId}`);
      }
      if (proposals[index].status !== EdgeProposalStatus.PENDING) {
        throw new Error(`Edge proposal is not pending: ${input.proposalId}`);
      }
      proposals[index] = {
        ...proposals[index],
        status: input.status,
        reviewer_identity: input.reviewerIdentity,
        review_reason: input.reviewReason,
        updated_at: input.reviewedAt
      };
      return proposals[index];
    }
  };
}

function createGraphPort() {
  return {
    findBySourceAndTarget: vi.fn(async () => null as MemoryGraphEdge | null),
    create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge)
  };
}

function createEventPublisher() {
  const appendManyWithMutationImpl: Pick<EventPublisher, "appendManyWithMutation">["appendManyWithMutation"] =
    async (_events, mutate) => mutate([]);
  return {
    appendManyWithMutation: vi.fn(appendManyWithMutationImpl)
  };
}

function createMemoryRepo(overrides: Record<string, string> = {}) {
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

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `proposal-${++counter}`;
}
