import { describe, expect, it, vi } from "vitest";
import { EdgeProposalStatus } from "@do-soul/alaya-protocol";
import { EdgeProposalService } from "../../path-graph/edge-proposal-service.js";
import type { PathMintOutcome } from "../../path-graph/path-relation-proposal-service.js";
import {
  createEventPublisher,
  createIdGenerator,
  createMemoryRepo,
  createPathCandidatePort,
  createProposalRepo
} from "./edge-proposal-service-test-fixtures.js";

describe("EdgeProposalService", () => {
  it("keeps the mint-failed audit and reconciles to terminal rejected when revert-to-pending collides with a duplicate pending re-proposal", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "failed");
    const eventPublisher = createEventPublisher();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort,
      eventPublisher,
      generateId: createIdGenerator(),
      now: () => "2026-05-24T00:00:00.000Z"
    });
    // P1 accepted (will fail to mint), then a duplicate pending P2 for the same
    // tuple is created while P1 sits accepted (its pending slot is free).
    const p1 = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });
    repo.forceStatus(p1.proposal_id, EdgeProposalStatus.ACCEPTED);
    const p2 = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });
    expect(p2.proposal_id).not.toBe(p1.proposal_id);
    repo.forceStatus(p1.proposal_id, EdgeProposalStatus.PENDING);
    // Re-accept P1 so it goes accepted -> mint fails -> reconcile collides.
    await expect(
      service.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [p1.proposal_id] },
        reason: "reviewed",
        reviewerIdentity: "user:reviewer"
      })
    ).rejects.toMatchObject({ code: "OBLIGATION_VIOLATION" });

    // The mint-failed audit STILL landed (constraint did not roll it back).
    const mintFailedEvents = eventPublisher.appendManyWithMutation.mock.calls
      .flatMap((call) => call[0])
      .filter((event) => event.event_type === "soul.graph.edge_proposal_path_mint_failed");
    expect(mintFailedEvents.some((event) => event.entity_id === p1.proposal_id)).toBe(true);

    // P1 is NOT left silently accepted-without-path: it is terminal rejected
    // (superseded), and P2 carries the live pending retry.
    const reconciledP1 = repo.findById(p1.proposal_id);
    expect(reconciledP1?.status).toBe(EdgeProposalStatus.REJECTED);
    expect(reconciledP1?.review_reason).toContain("supersede");
    expect(service.listPending("workspace-1").proposals.map((p) => p.proposal_id)).toContain(p2.proposal_id);
    expect(service.listPending("workspace-1").proposals.map((p) => p.proposal_id)).not.toContain(p1.proposal_id);
  });

  // invariant (FIX-2): a crash-window orphan — accepted/auto_accepted with no
  // path — is recovered by the bounded reconcile sweep. After the pass exactly
  // one path exists (re-driven mint applied), and re-running the pass is a
  // no-op (already_present, no second mint applied).
  it("reconcileStuckAccepts re-drives a crash-window accepted-without-path orphan to exactly one path and is idempotent", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    // First re-drive applies; subsequent ones report the path already exists.
    pathCandidatePort.submitCandidate
      .mockImplementationOnce(async (): Promise<PathMintOutcome> => "applied")
      .mockImplementation(async (): Promise<PathMintOutcome> => "already_present");
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
    // Simulate the crash-window state: accepted committed, mint never ran.
    repo.forceStatus(proposal.proposal_id, EdgeProposalStatus.ACCEPTED);

    const first = await service.reconcileStuckAccepts({ workspaceId: "workspace-1", limit: 32 });
    expect(first).toMatchObject({ scanned: 1, reminted: 1, already_present: 0, rejected: 0, transient_failed: 0 });
    expect(pathCandidatePort.submitCandidate).toHaveBeenCalledTimes(1);
    // The proposal stays accepted (the owed path now exists).
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.ACCEPTED);

    // Re-running the pass is a no-op: the path already exists, no new mint lands.
    const second = await service.reconcileStuckAccepts({ workspaceId: "workspace-1", limit: 32 });
    expect(second).toMatchObject({ scanned: 1, reminted: 0, already_present: 1 });
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.ACCEPTED);
  });

  // invariant (FIX-2): a crash-window orphan whose owed path can never mint (a
  // permanent anchor rejection) is moved to terminal rejected by the sweep, so
  // it leaves the accepted-awaiting-path set and the next pass does not re-scan it.
  it("reconcileStuckAccepts moves a permanently-rejected crash-window orphan to terminal rejected", async () => {
    const repo = createProposalRepo();
    const pathCandidatePort = createPathCandidatePort();
    pathCandidatePort.submitCandidate.mockImplementation(async (): Promise<PathMintOutcome> => "rejected");
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
    repo.forceStatus(proposal.proposal_id, EdgeProposalStatus.AUTO_ACCEPTED);

    const result = await service.reconcileStuckAccepts({ workspaceId: "workspace-1", limit: 32 });
    expect(result).toMatchObject({ scanned: 1, rejected: 1, reminted: 0 });
    expect(repo.findById(proposal.proposal_id)?.status).toBe(EdgeProposalStatus.REJECTED);
    // Leaves the accepted-awaiting-path set, so the next pass scans nothing.
    const second = await service.reconcileStuckAccepts({ workspaceId: "workspace-1", limit: 32 });
    expect(second).toMatchObject({ scanned: 0 });
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

  // B5(a): edge-proposal TTL — proposeEdge stamps a default expires_at and the
  // sweep flips past-TTL pending proposals to terminal `expired`.
  it("stamps a default expires_at at creation when the caller supplies none", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort: createPathCandidatePort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "p1",
      now: () => "2026-05-24T00:00:00.000Z"
    });
    const proposal = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1"
    });
    // created_at 2026-05-24 + 30d = 2026-06-23.
    expect(proposal.expires_at).toBe("2026-06-23T00:00:00.000Z");
  });

  it("honors an explicit caller expiresAt over the default TTL", async () => {
    const repo = createProposalRepo();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort: createPathCandidatePort(),
      eventPublisher: createEventPublisher(),
      generateId: () => "p1",
      now: () => "2026-05-24T00:00:00.000Z"
    });
    const proposal = await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      expiresAt: "2026-05-25T00:00:00.000Z"
    });
    expect(proposal.expires_at).toBe("2026-05-25T00:00:00.000Z");
  });

  it("sweepExpired flips a past-TTL pending proposal to terminal expired with an audited reviewer", async () => {
    const repo = createProposalRepo();
    const eventPublisher = createEventPublisher();
    let nowIso = "2026-05-24T00:00:00.000Z";
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      pathCandidatePort: createPathCandidatePort(),
      eventPublisher,
      generateId: () => "p1",
      now: () => nowIso
    });
    await service.proposeEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      expiresAt: "2026-05-25T00:00:00.000Z"
    });
    // before the TTL: nothing expires.
    const before = await service.sweepExpired({ workspaceId: "workspace-1", limit: 16 });
    expect(before).toEqual({ scanned: 0, expired: 0, skipped: 0 });

    // after the TTL: the pending proposal is flipped to expired.
    nowIso = "2026-05-26T00:00:00.000Z";
    const after = await service.sweepExpired({ workspaceId: "workspace-1", limit: 16 });
    expect(after).toEqual({ scanned: 1, expired: 1, skipped: 0 });
    expect(repo.findById("edge_prop_p1")).toMatchObject({
      status: EdgeProposalStatus.EXPIRED,
      reviewer_identity: "system:edge_proposal_ttl_policy"
    });
    expect(eventPublisher.appendManyWithMutation).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          event_type: "soul.graph.edge_proposal_reviewed",
          entity_id: "edge_prop_p1"
        })
      ],
      expect.any(Function)
    );
  });

  // D-EDGEAUDIT: an accept-owed path mint failure surfaces a health_inbox entry
  // in addition to the durable EventLog audit, best-effort.
  it("records a health_inbox path-relation-failure on accept-owed mint failure", async () => {
    const repo = createProposalRepo();
    const recordPathRelationFailure = vi.fn();
    const service = new EdgeProposalService({
      memoryRepo: createMemoryRepo(),
      proposalRepo: repo,
      // a permanent "rejected" mint outcome drives handleMintFailure.
      pathCandidatePort: { submitCandidate: vi.fn(async (): Promise<PathMintOutcome> => "rejected") },
      eventPublisher: createEventPublisher(),
      healthInboxPort: { recordPathRelationFailure },
      generateId: createIdGenerator(),
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
        reason: null,
        reviewerIdentity: "operator-1"
      })
    ).rejects.toMatchObject({ name: "CoreError", code: "OBLIGATION_VIOLATION" });
    expect(recordPathRelationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", targetObjectId: "memory-a" })
    );
  });
});
