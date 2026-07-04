import { describe, expect, it } from "vitest";
import { EdgeProposalStatus, EdgeProposalTriggerSource } from "@do-soul/alaya-protocol";
import { AUTO_ACCEPT_FLOOR_BY_TRIGGER, AUTO_ACCEPT_REVIEWER_IDENTITY, EdgeProposalService } from "../../path-graph/edge-proposals/edge-proposal-service.js";
import { createAutoAcceptHarness, createEventPublisher, createMemoryRepo, createPathCandidatePort, createProposalRepo } from "./edge-proposal-service-test-fixtures.js";

describe("EdgeProposalService", () => {
// invariant: submitCandidate is contracted to catch its own materialize
  // errors and return a discriminated outcome, but a thrown error must still produce the durable
  // obligation record before propagating — auditability cannot depend on the
  // failure-arrival shape.
  it("emits a durable path-mint-failed record AND throws when submitCandidate throws", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async () => {
      throw new Error("materialize blew up");
    });
    const eventPublisher = createEventPublisher();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort,
      eventPublisher,
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
        reason: "reviewed",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "OBLIGATION_VIOLATION",
      message: `Edge proposal accepted but path mint failed: ${proposal.proposal_id}`
    });

    const mintFailedEvents = eventPublisher.appendManyWithMutation.mock.calls
      .flatMap((call) => call[0])
      .filter((event) => event.event_type === "soul.graph.edge_proposal_path_mint_failed");
    expect(mintFailedEvents).toHaveLength(1);
    expect(mintFailedEvents[0].payload_json).toMatchObject({
      proposal_id: proposal.proposal_id,
      failure_kind: "submit_threw",
      failure_detail: "materialize blew up",
      workspace_id: "workspace-1"
    });
  });

it("does not mint a path when the pending review CAS loses the race", async () => {
    const repo = createProposalRepo({
      beforeUpdateReview: (proposalId) => {
        repo.forceStatus(proposalId, EdgeProposalStatus.REJECTED);
      }
    });
    const pathCandidatePort = createPathCandidatePort();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort,
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
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
  });

it("fails closed when explicit proposal ids are no longer pending", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort: createPathCandidatePort(),
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
      pathCandidatePort: createPathCandidatePort(),
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
      pathCandidatePort: createPathCandidatePort(),
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
      pathCandidatePort: createPathCandidatePort(),
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
  // stays pending when confidence < floor. The floor table is the single
  // source of truth so this loop iterates the published map. Only
  // RECALL_CROSS_LINK reaches proposeEdge through an auto-accept-eligible
  // route; the other triggers direct-materialize and never enter this table.
  describe("system-policy auto-accept by trigger floor", () => {
    const cases: ReadonlyArray<{
      readonly trigger: keyof typeof AUTO_ACCEPT_FLOOR_BY_TRIGGER;
      readonly edgeType: "recalls" | "supports" | "supersedes" | "derives_from" | "contradicts";
    }> = [
      { trigger: EdgeProposalTriggerSource.RECALL_CROSS_LINK, edgeType: "recalls" }
    ];

    for (const { trigger, edgeType } of cases) {
      const floor = AUTO_ACCEPT_FLOOR_BY_TRIGGER[trigger];
      if (floor === undefined) {
        throw new Error(`floor missing for ${trigger}`);
      }

      it(`auto-accepts ${trigger} when confidence == floor (${floor})`, async () => {
        const { service, repo, pathCandidatePort } = createAutoAcceptHarness();
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
        expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
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
        const { service, repo, pathCandidatePort } = createAutoAcceptHarness();
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
        expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
      });
    }

    it("never auto-accepts EXPLICIT trigger even at confidence = 1.0 (agent self-report ceiling clamps to 0.5)", async () => {
      const { service, repo, pathCandidatePort } = createAutoAcceptHarness();
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
      expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
    });

    // invariant: every trigger absent from AUTO_ACCEPT_FLOOR_BY_TRIGGER stays
    // pending at any confidence. SYSTEM / CANDIDATE_SIGNAL_REF / BENCH_SEED keep
    // a human in the loop by design. The LLM/local rule triggers and
    // CONFLICT_DETECTION never reach proposeEdge in production (they
    // direct-materialize via PathCandidateSink), so their floor rows were
    // removed as dead config — if a future caller did route one here, it MUST
    // stay pending, never silently auto-accept.
    it("never auto-accepts any trigger absent from the floor table at any confidence", async () => {
      const nonAutoAcceptTriggers = [
        EdgeProposalTriggerSource.SYSTEM,
        EdgeProposalTriggerSource.CANDIDATE_SIGNAL_REF,
        EdgeProposalTriggerSource.BENCH_SEED,
        EdgeProposalTriggerSource.LLM_SUPPORTS,
        EdgeProposalTriggerSource.LOCAL_SUPPORTS,
        EdgeProposalTriggerSource.LOCAL_DERIVES_FROM,
        EdgeProposalTriggerSource.LOCAL_SUPERSEDES,
        EdgeProposalTriggerSource.CONFLICT_DETECTION
      ] as const;
      for (const trigger of nonAutoAcceptTriggers) {
        const { service, repo, pathCandidatePort } = createAutoAcceptHarness();
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
        expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
      }
    });

    // invariant: the floor table is exactly { RECALL_CROSS_LINK } — the only
    // trigger that reaches proposeEdge through an auto-accept-eligible route.
    // Locks the dead-config removal: re-adding a floor for a direct-materialize
    // trigger (LLM/local rule, CONFLICT_DETECTION) is dead config and trips here.
    it("floor table contains only the reachable auto-accept trigger (RECALL_CROSS_LINK)", () => {
      expect(Object.keys(AUTO_ACCEPT_FLOOR_BY_TRIGGER)).toEqual([
        EdgeProposalTriggerSource.RECALL_CROSS_LINK
      ]);
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

    it("idempotent: a duplicate proposeEdge call returns the already-auto-accepted proposal and mints one path per accept", async () => {
      const { service, repo, pathCandidatePort, eventPublisher } = createAutoAcceptHarness();
      const first = await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9
      });
      expect(first.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
      const submitCallsAfterFirst = pathCandidatePort.submitCandidate.mock.calls.length;
      const reviewedEventsAfterFirst = eventPublisher.appendManyWithMutation.mock.calls
        .map((call) => call[0])
        .filter((events) =>
          events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed")
        ).length;
      // findPendingDuplicate only matches status=pending; an auto-accepted
      // proposal does NOT block a fresh proposeEdge. The unit emits one
      // submitCandidate per accept; durable path dedup is the path service's
      // job (findByAnchorMemoryId), not this service's.
      const second = await service.proposeEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "recalls",
        workspaceId: "workspace-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9
      });
      expect(second.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
      const submitCallsAfterSecond = pathCandidatePort.submitCandidate.mock.calls.length;
      expect(submitCallsAfterSecond).toBe(submitCallsAfterFirst + 1);
      // Each accept commits exactly one reviewed event.
      const reviewedEventsAfterSecond = eventPublisher.appendManyWithMutation.mock.calls
        .map((call) => call[0])
        .filter((events) =>
          events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed")
        ).length;
      expect(reviewedEventsAfterSecond - reviewedEventsAfterFirst).toBe(1);
      const stored = repo.findById(first.proposal_id);
      expect(stored?.status).toBe(EdgeProposalStatus.AUTO_ACCEPTED);
    });
  });
});
