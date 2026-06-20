import { describe, expect, it } from "vitest";
import { EdgeProposalStatus, EdgeProposalTriggerSource } from "@do-soul/alaya-protocol";
import { EdgeProposalService } from "../../path-graph/edge-proposal-service.js";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";
import { createAutoAcceptHarness, createEventPublisher, createIdGenerator, createMemoryRepo, createPathCandidatePort, createProposalRepo } from "./edge-proposal-service-test-fixtures.js";

describe("EdgeProposalService", () => {
it("creates a pending proposal without writing a durable graph edge", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
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
    expect(pathCandidatePort.submitCandidate).not.toHaveBeenCalled();
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

it("accept mints a governed path relation and reject does not", async () => {
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

    // invariant: accept mints exactly one governed path (recall_allowed),
    // relation_kind == edge_type, recall_bias positive for `recalls`.
    // recallBiasMagnitude/initialStrength are pinned to the recalls seed
    // profile (|contribution_weight| 0.3, clamped to the 0.3 strength floor)
    // so a drift in EDGE_TYPE_RECALL_MODEL is caught here.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceAnchor: { kind: "object", object_id: "memory-a" },
      targetAnchor: { kind: "object", object_id: "memory-b" },
      relationKind: "recalls",
      governanceClass: "recall_allowed",
      recallBiasSign: 1,
      recallBiasMagnitude: 0.3,
      initialStrength: 0.3
    }));
    // The accepted reviewed event commits before the path is minted; there is
    // no soul.graph.edge_created event any more.
    const reviewEventBatches = eventPublisher.appendManyWithMutation.mock.calls
      .map((call) => call[0])
      .filter((events) => events.some((event) => event.event_type === "soul.graph.edge_proposal_reviewed"));
    expect(reviewEventBatches).toEqual([
      [expect.objectContaining({ event_type: "soul.graph.edge_proposal_reviewed" })],
      [expect.objectContaining({ event_type: "soul.graph.edge_proposal_reviewed" })]
    ]);
    const emittedTypes = eventPublisher.appendManyWithMutation.mock.calls
      .flatMap((call) => call[0])
      .map((event) => event.event_type);
    expect(emittedTypes).not.toContain("soul.graph.edge_created");
    expect(repo.findById(accepted.proposal_id)?.status).toBe(EdgeProposalStatus.ACCEPTED);
    expect(repo.findById(rejected.proposal_id)?.status).toBe(EdgeProposalStatus.REJECTED);
  });

// invariant (Wave-1): an AUTO_ACCEPTED negative edge_type mint is NOT a trust
  // verdict — it must be born attention_only so it cannot suppress (suppression
  // gate requires recall_allowed; negative governance promotion is sign-guarded
  // off). recall_allowed for a negative path is reachable only via a trusted
  // llm-verdict birth seed or a human governance decision. No production
  // proposeEdge trigger auto-accepts a negative edge (RECALL_CROSS_LINK is the
  // only floor-mapped trigger and maps to positive `recalls`), so this band is
  // exercised through the reachable path: the reconcile sweep re-driving the
  // owed mint of an AUTO_ACCEPTED negative row.
  it("AUTO_ACCEPTED negative edge_type mints an attention_only path (cannot suppress)", async () => {
    const negativeCases: ReadonlyArray<"contradicts" | "supersedes"> = ["contradicts", "supersedes"];
    for (const edgeType of negativeCases) {
      const repo = createProposalRepo();
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
        edgeType,
        workspaceId: "workspace-1"
      });
      // Force the crash-window AUTO_ACCEPTED-without-path state, then let the
      // reconcile sweep re-drive the owed mint (the reachable auto-accept mint).
      repo.forceStatus(proposal.proposal_id, EdgeProposalStatus.AUTO_ACCEPTED);
      await service.reconcileStuckAccepts({ workspaceId: "workspace-1", limit: 32 });
      expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
      const mintArgs = pathCandidatePort.submitCandidate.mock.calls[0][0];
      expect(mintArgs.relationKind).toBe(edgeType);
      expect(mintArgs.recallBiasSign).toBe(-1);
      expect(mintArgs.governanceClass).toBe("attention_only");
      expect(mintArgs.governanceClass).not.toBe("recall_allowed");
    }
  });

// invariant: a negative edge_type accepted by a HUMAN reviewer is a trust
  // verdict — human-vetted suppression — so the minted path keeps
  // recall_allowed (legitimate suppression authority preserved).
  it("human ACCEPTED negative edge_type mints a recall_allowed path (human-vetted suppression preserved)", async () => {
    const repo = createProposalRepo();
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
      edgeType: "contradicts",
      workspaceId: "workspace-1"
    });
    await service.batchReview({
      workspaceId: "workspace-1",
      verdict: "accept",
      filter: { proposal_ids: [proposal.proposal_id] },
      reason: "human-vetted suppression",
      reviewerIdentity: "user:reviewer"
    });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    const mintArgs = pathCandidatePort.submitCandidate.mock.calls[0][0];
    expect(mintArgs.relationKind).toBe("contradicts");
    expect(mintArgs.recallBiasSign).toBe(-1);
    expect(mintArgs.governanceClass).toBe("recall_allowed");
  });

// invariant: positive (sign >= 0) edge_types keep recall_allowed for both
  // auto and human accept — positive recall_allowed only nudges recall and
  // never suppresses, so no auto/human downgrade is required.
  it("AUTO_ACCEPTED positive edge_type keeps recall_allowed (no regression)", async () => {
    const { service, pathCandidatePort } = createAutoAcceptHarness();
    await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      confidence: 1
    });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    const mintArgs = pathCandidatePort.submitCandidate.mock.calls[0][0];
    expect(mintArgs.relationKind).toBe("recalls");
    expect(mintArgs.recallBiasSign).toBe(1);
    expect(mintArgs.governanceClass).toBe("recall_allowed");
  });

// invariant (I1): the minted path is the only durable landing for an accepted
  // proposal. submitCandidate catches its own materialize errors and returns the
  // transient "failed" outcome; acceptProposal must surface that loudly
  // (CoreError) AND reconcile the review row back to pending so the
  // accepted-without-path obligation is operator-recoverable, never silent.
  it("throws an observable failure and reverts a transient-failed accept to pending (no silent lost mint)", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "failed");
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
        reason: "reviewed",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "OBLIGATION_VIOLATION",
      message: `Edge proposal accepted but path mint failed: ${proposal.proposal_id}`
    });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    // A transient failure leaves the proposal selectable through the existing
    // pending review surface, not stuck terminal-accepted-without-path.
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.PENDING);
  });

// invariant (I1): a transient mint failure is operator-retryable through the
  // EXISTING pending review surface and a successful retry lands EXACTLY ONE
  // path (no duplicate, no stuck terminal-accepted-without-path). The path
  // service dedups via findByAnchorMemoryId, but this service must not double
  // the accept review row either: the first accept reverted to pending, the
  // retry accepts it cleanly.
  it("operator can retry a transient-failed proposal and land exactly one path", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementationOnce(async (): Promise<PathMintOutcome> => "failed");
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
        reason: "first accept",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({ code: "OBLIGATION_VIOLATION" });
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.PENDING);
    // The same proposal is still pending, so it re-surfaces in the pending list
    // (the existing review surface) for retry — no new verb required.
    expect(service.listPending("workspace-1").proposals.map((p) => p.proposal_id)).toContain(
      proposal.proposal_id
    );

    // Retry: submitCandidate now applies (default mock). Exactly one further
    // mint call, and the proposal lands ACCEPTED.
    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [proposal.proposal_id] },
        reason: "retry accept",
        reviewerIdentity: "user:reviewer"
      })
    ).resolves.toMatchObject({ accepted_count: 1, rejected_count: 0 });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(2);
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.ACCEPTED);
    // No longer pending after the successful retry, so it leaves the pending list.
    expect(service.listPending("workspace-1").proposals.map((p) => p.proposal_id)).not.toContain(
      proposal.proposal_id
    );
  });

// invariant (auditability): the reviewed row commits BEFORE submitCandidate
  // runs, so on mint failure an accepted-owes-a-path obligation exists with no
  // PATH_RELATION_CREATED. The throw alone reaches a different session (the
  // propose_edge caller for auto-accept) and leaves no durable trace. A durable
  // SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED event keyed on proposal_id must be
  // emitted so an operator can reconcile the obligation without a forensic
  // cross-join. The OBLIGATION_VIOLATION throw stays (loud at call time).
  it("emits a durable path-mint-failed record AND throws when submitCandidate returns a transient failed", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "failed");
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
    expect(mintFailedEvents[0]).toMatchObject({
      entity_type: "edge_proposal",
      entity_id: proposal.proposal_id,
      caused_by: "user:reviewer"
    });
    expect(mintFailedEvents[0].payload_json).toMatchObject({
      proposal_id: proposal.proposal_id,
      source_memory_id: "memory-a",
      target_memory_id: "memory-b",
      edge_type: "recalls",
      reviewer_identity: "user:reviewer",
      failure_kind: "submit_returned_false",
      failure_detail: null,
      workspace_id: "workspace-1"
    });
  });

// invariant (I1): a permanent "rejected" outcome (bad anchor — a missing /
  // foreign source or target memory) on an ACCEPTED proposal can NEVER mint a
  // path, so retry is futile. It records the durable mint-failed audit and
  // throws (loud), AND it reconciles the review row to terminal REJECTED so the
  // proposal leaves the pending list — never a retry poison pill. A re-list
  // must not resurface it.
  it("auto-rejects a permanent-rejected accept to terminal rejected (no futile retry) and records the mint-failed audit", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "rejected");
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
      failure_kind: "submit_returned_false",
      workspace_id: "workspace-1"
    });
    // Terminal rejected with the mint-failure review_reason, not pending, not
    // accepted-without-path. It leaves the pending list -> no futile re-accept.
    const reconciled = repo.findById(proposal.proposal_id);
    expect(reconciled?.status).toBe(EdgeProposalStatus.REJECTED);
    expect(reconciled?.review_reason).toContain("permanent path-anchor refusal");
    expect(service.listPending("workspace-1").proposals.map((p) => p.proposal_id)).not.toContain(
      proposal.proposal_id
    );
    // A second batchReview accept against the now-rejected proposal fails closed
    // (it is no longer pending), so it cannot become a retry poison pill.
    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [proposal.proposal_id] },
        reason: "futile retry",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // No further mint attempt for a proposal that can never mint.
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
  });
});
