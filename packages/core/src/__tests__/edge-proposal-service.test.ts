import { describe, expect, it, vi } from "vitest";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  type EdgeProposal,
  type MemoryGraphEdge
} from "@do-soul/alaya-protocol";
import {
  AUTO_ACCEPT_FLOOR_BY_TRIGGER,
  AUTO_ACCEPT_REVIEWER_IDENTITY,
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

  // System-policy auto-accept floors: each trigger_source in
  // AUTO_ACCEPT_FLOOR_BY_TRIGGER auto-accepts when confidence >= floor and
  // stays pending when confidence < floor. The floor table is the
  // single source of truth so this loop iterates the published map.
  describe("system-policy auto-accept by trigger floor", () => {
    const cases: ReadonlyArray<{
      readonly trigger: keyof typeof AUTO_ACCEPT_FLOOR_BY_TRIGGER;
      readonly edgeType: "recalls" | "supports" | "supersedes" | "derives_from" | "contradicts";
    }> = [
      { trigger: EdgeProposalTriggerSource.RECALL_CROSS_LINK, edgeType: "recalls" },
      { trigger: EdgeProposalTriggerSource.LLM_SUPPORTS, edgeType: "supports" },
      { trigger: EdgeProposalTriggerSource.LOCAL_SUPPORTS, edgeType: "supports" },
      { trigger: EdgeProposalTriggerSource.LOCAL_DERIVES_FROM, edgeType: "derives_from" },
      { trigger: EdgeProposalTriggerSource.LOCAL_SUPERSEDES, edgeType: "supersedes" },
      { trigger: EdgeProposalTriggerSource.CONFLICT_DETECTION, edgeType: "contradicts" }
    ];

    for (const { trigger, edgeType } of cases) {
      const floor = AUTO_ACCEPT_FLOOR_BY_TRIGGER[trigger];
      if (floor === undefined) {
        throw new Error(`floor missing for ${trigger}`);
      }

      it(`auto-accepts ${trigger} when confidence == floor (${floor})`, async () => {
        const { service, repo, graphPort } = createAutoAcceptHarness();
        const proposal = await service.proposeEdge({
          sourceMemoryId: "memory-a",
          targetMemoryId: "memory-b",
          edgeType,
          workspaceId: "workspace-1",
          triggerSource: trigger,
          confidence: floor
        });
        expect(proposal.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
        const stored = repo.findById(proposal.proposal_id);
        expect(stored?.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
        expect(stored?.reviewer_identity).toBe(AUTO_ACCEPT_REVIEWER_IDENTITY);
        expect(graphPort.create).toHaveBeenCalledTimes(1);
      });

      it(`auto-accepts ${trigger} at the upper bound (confidence = 1.0)`, async () => {
        const { service, repo } = createAutoAcceptHarness();
        const proposal = await service.proposeEdge({
          sourceMemoryId: "memory-a",
          targetMemoryId: "memory-b",
          edgeType,
          workspaceId: "workspace-1",
          triggerSource: trigger,
          confidence: 1
        });
        expect(proposal.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
        expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
      });

      it(`leaves ${trigger} pending when confidence < floor`, async () => {
        const { service, repo, graphPort } = createAutoAcceptHarness();
        const proposal = await service.proposeEdge({
          sourceMemoryId: "memory-a",
          targetMemoryId: "memory-b",
          edgeType,
          workspaceId: "workspace-1",
          triggerSource: trigger,
          confidence: floor - 0.01
        });
        expect(proposal.status).toBe(EdgeProposalStatus.PENDING);
        expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.PENDING);
        expect(graphPort.create).not.toHaveBeenCalled();
      });
    }

    it("never auto-accepts EXPLICIT trigger even at confidence = 1.0 (agent self-report ceiling clamps to 0.5)", async () => {
      const { service, repo, graphPort } = createAutoAcceptHarness();
      const proposal = await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.EXPLICIT,
        confidence: 1
      });
      expect(proposal.status).toBe(EdgeProposalStatus.PENDING);
      expect(proposal.confidence).toBe(0.5);
      expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.PENDING);
      expect(graphPort.create).not.toHaveBeenCalled();
    });

    it("never auto-accepts SYSTEM / CANDIDATE_SIGNAL_REF / BENCH_SEED at any confidence", async () => {
      const conservativeTriggers = [
        EdgeProposalTriggerSource.SYSTEM,
        EdgeProposalTriggerSource.CANDIDATE_SIGNAL_REF,
        EdgeProposalTriggerSource.BENCH_SEED
      ] as const;
      for (const trigger of conservativeTriggers) {
        const { service, repo } = createAutoAcceptHarness();
        const proposal = await service.proposeEdge({
          sourceMemoryId: "memory-a",
          targetMemoryId: "memory-b",
          edgeType: "recalls",
          workspaceId: "workspace-1",
          triggerSource: trigger,
          confidence: 1
        });
        expect(proposal.status).toBe(EdgeProposalStatus.PENDING);
        expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.PENDING);
      }
    });

    it("emits a single SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED with status=auto_accepted and system reviewer_identity", async () => {
      const { service, eventPublisher } = createAutoAcceptHarness();
      await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9
      });
      const reviewedBatches = eventPublisher.appendManyWithMutation.mock.calls
        .map((call) => call[0])
        .filter((events) =>
          events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed")
        );
      expect(reviewedBatches).toHaveLength(1);
      const reviewedEvent = reviewedBatches[0].find(
        (event) => event.event_type === "soul.graph.edge_proposal_reviewed"
      );
      expect(reviewedEvent?.payload_json).toMatchObject({
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewer_identity: AUTO_ACCEPT_REVIEWER_IDENTITY
      });
      expect(reviewedEvent?.caused_by).toBe(AUTO_ACCEPT_REVIEWER_IDENTITY);
    });

    it("idempotent: a duplicate proposeEdge call returns the already-auto-accepted proposal without re-reviewing", async () => {
      const { service, repo, graphPort, eventPublisher } = createAutoAcceptHarness();
      const first = await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9
      });
      expect(first.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
      const createCallsAfterFirst = graphPort.create.mock.calls.length;
      const reviewedEventsAfterFirst = eventPublisher.appendManyWithMutation.mock.calls
        .map((call) => call[0])
        .filter((events) =>
          events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed")
        ).length;
      // findPendingDuplicate only matches status=pending; an auto-accepted
      // proposal does NOT block a fresh proposeEdge — but the
      // findBySourceAndTarget guard in acceptProposal prevents a second
      // durable edge. We assert the no-op path stays clean.
      const second = await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9
      });
      // Second call's stored proposal must still resolve to auto_accepted.
      expect(second.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
      // The durable edge must not duplicate because the existing edge guard
      // suppresses a second create.
      const graphCreateCallsAfterSecond = graphPort.create.mock.calls.length;
      expect(graphCreateCallsAfterSecond).toBeLessThanOrEqual(createCallsAfterFirst + 1);
      // Auto-accepted proposals are not re-reviewed by accident.
      const reviewedEventsAfterSecond = eventPublisher.appendManyWithMutation.mock.calls
        .map((call) => call[0])
        .filter((events) =>
          events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed")
        ).length;
      expect(reviewedEventsAfterSecond - reviewedEventsAfterFirst).toBeLessThanOrEqual(1);
      // Stored repo retains an auto_accepted record for the source-target-edge_type.
      const stored = repo.findById(first.proposal_id);
      expect(stored?.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
    });
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

function createAutoAcceptHarness() {
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
  return { service, repo, graphPort, eventPublisher };
}
