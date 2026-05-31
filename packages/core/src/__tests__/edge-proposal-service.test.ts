import { describe, expect, it, vi } from "vitest";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  type EdgeProposal,
  type EdgeProposalTriggerSourceValue
} from "@do-soul/alaya-protocol";
import {
  AUTO_ACCEPT_FLOOR_BY_TRIGGER,
  AUTO_ACCEPT_REVIEWER_IDENTITY,
  EdgeProposalService,
  type EdgeProposalRepoPort
} from "../edge-proposal-service.js";
import type { EventPublisher } from "../event-publisher.js";
import type { PathCandidateSink } from "../path-candidate-sink.js";
import type { PathMintOutcome } from "../path-relation-proposal-service.js";

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

  // invariant (Wave-1): a negative edge_type AUTO_ACCEPTED by system floor
  // policy is NOT a trust verdict — it must mint an attention_only path that
  // cannot suppress (suppression gate requires recall_allowed; negative
  // governance promotion is sign-guarded off). recall_allowed for a negative
  // path is reachable only via a trusted llm-verdict birth seed or a human
  // governance decision.
  it("AUTO_ACCEPTED negative edge_type mints an attention_only path (cannot suppress)", async () => {
    const negativeCases: ReadonlyArray<{
      readonly trigger: EdgeProposalTriggerSourceValue;
      readonly edgeType: "contradicts" | "supersedes";
    }> = [
      { trigger: EdgeProposalTriggerSource.CONFLICT_DETECTION, edgeType: "contradicts" },
      { trigger: EdgeProposalTriggerSource.LOCAL_SUPERSEDES, edgeType: "supersedes" }
    ];
    for (const { trigger, edgeType } of negativeCases) {
      const { service, repo, pathCandidatePort } = createAutoAcceptHarness();
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
      edgeType: "supports",
      workspaceId: "workspace-1",
      triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
      confidence: 1
    });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    const mintArgs = pathCandidatePort.submitCandidate.mock.calls[0][0];
    expect(mintArgs.relationKind).toBe("supports");
    expect(mintArgs.recallBiasSign).toBe(1);
    expect(mintArgs.governanceClass).toBe("recall_allowed");
  });

  // invariant (I-1): the minted path is the only durable landing for an
  // accepted proposal. submitCandidate catches its own materialize errors and
  // returns the transient "failed" outcome; acceptProposal must surface that
  // loudly (CoreError) so an accepted-without-path loss is never silent. The
  // review row already committed, so the proposal stays ACCEPTED — but the
  // failure is observable and a retry is idempotent (materialize dedups via
  // findByAnchorMemoryId).
  it("throws an observable failure when submitCandidate returns a transient failed (no silent lost mint)", async () => {
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

  // invariant: a permanent "rejected" outcome (bad anchor — a missing /
  // foreign source or target memory) on an ACCEPTED proposal still has no
  // landing path, so it is an obligation violation: it must record the same
  // durable mint-failed audit event and throw, exactly like a transient
  // "failed". The distinction matters for retry-driven consumers (the
  // bulk-enrich worker), not for the accept→mint path, which is always loud.
  it("emits a durable path-mint-failed record AND throws when submitCandidate returns a permanent rejected", async () => {
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
  });

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

  it("rejects cross-workspace endpoints before proposing", async () => {
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo({ "memory-b": "workspace-2" }),
      proposalRepo: createProposalRepo(),
      pathCandidatePort: createPathCandidatePort(),
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

function createPathCandidatePort(): PathCandidateSink & {
  submitCandidate: ReturnType<typeof vi.fn>;
} {
  return {
    submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "applied")
  };
}

function createEventPublisher() {
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
