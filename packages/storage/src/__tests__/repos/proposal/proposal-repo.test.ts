import { afterEach, describe, expect, it } from "vitest";
import {
  GreenGovernanceEventType,
  GreenState,
  MemoryGovernanceEventType,
  RevokeReason
} from "@do-soul/alaya-protocol";
import { SqliteGreenStatusRepo } from "../../../repos/health/green-status-repo.js";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";

import {
  countGreenPiercedEvents,
  countMemoryUpdatedEvents,
  countProposalEvents,
  countSynthesisCapsules,
  countSynthesisCreatedEvents,
  createCreationEvents,
  createGreenStatus,
  createMemoryEntry,
  createProposal,
  createRepo,
  createReviewEvents,
  createSynthesisCapsule,
  createSynthesisProposal,
  trackedDatabases
} from "./proposal-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteProposalRepo", () => {
  it("creates and loads proposal by proposal id", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();

    await expect(
      repo.create({
        proposal,
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "memory_entry"
      })
    ).resolves.toEqual(proposal);

    await expect(repo.findById(proposal.proposal_id)).resolves.toEqual(proposal);
    await expect(repo.findScopedById(proposal.proposal_id)).resolves.toEqual({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      reviewer_identity: null,
      reviewer_assignment: null,
      proposed_changes: null,
      proposed_path_relation: null,
      target_baseline_updated_at: null,
      source_delivery_ids: null
    });
  });

  it("round-trips optional source delivery anchors on scoped proposals", async () => {
    const { repo } = createRepo();
    const singleAnchorProposal = createProposal({
      runtime_id: "a1111111-1111-4111-8111-111111111111",
      proposal_id: "a1111111-1111-4111-8111-111111111111"
    });
    const multiAnchorProposal = createProposal({
      runtime_id: "b2222222-2222-4222-8222-222222222222",
      proposal_id: "b2222222-2222-4222-8222-222222222222"
    });
    const omittedAnchorProposal = createProposal({
      runtime_id: "c3333333-3333-4333-8333-333333333333",
      proposal_id: "c3333333-3333-4333-8333-333333333333"
    });

    await repo.create({
      proposal: singleAnchorProposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      source_delivery_ids: ["delivery-1"]
    });
    await repo.create({
      proposal: multiAnchorProposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      source_delivery_ids: ["delivery-1", "delivery-2"]
    });
    await repo.create({
      proposal: omittedAnchorProposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });

    await expect(repo.findScopedById(singleAnchorProposal.proposal_id)).resolves.toMatchObject({
      source_delivery_ids: ["delivery-1"]
    });
    await expect(repo.findScopedById(multiAnchorProposal.proposal_id)).resolves.toMatchObject({
      source_delivery_ids: ["delivery-1", "delivery-2"]
    });
    await expect(repo.findScopedById(omittedAnchorProposal.proposal_id)).resolves.toMatchObject({
      source_delivery_ids: null
    });
  });

  it("stores proposed memory changes only on the scoped proposal projection", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();

    await repo.createProposalWithEvents(
      {
        proposal,
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "memory_entry",
        proposed_change_summary: "Switch to pnpm",
        proposed_changes: {
          content: "Use pnpm for workspace commands.",
          domain_tags: ["tooling"],
          evidence_refs: ["evidence-1"]
        }
      },
      createCreationEvents(proposal)
    );

    await expect(repo.findById(proposal.proposal_id)).resolves.toEqual(proposal);
    await expect(repo.findScopedById(proposal.proposal_id)).resolves.toMatchObject({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      proposed_changes: {
        content: "Use pnpm for workspace commands.",
        domain_tags: ["tooling"],
        evidence_refs: ["evidence-1"]
      }
    });
  });

  it("lists all and pending proposals by workspace", async () => {
    const { repo } = createRepo();

    const firstPending = createProposal({
      runtime_id: "22147873-6c23-4a7e-8f0c-bfd176664de5",
      proposal_id: "22147873-6c23-4a7e-8f0c-bfd176664de5",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
    const accepted = createProposal({
      runtime_id: "6f9fb55d-f637-4bd9-95df-2539da4fce9a",
      proposal_id: "6f9fb55d-f637-4bd9-95df-2539da4fce9a",
      resolution_state: "accepted",
      last_updated_at: "2026-03-21T01:00:00.000Z"
    });
    const secondPending = createProposal({
      runtime_id: "f5520f90-7135-4065-b1f5-0af1f6144456",
      proposal_id: "f5520f90-7135-4065-b1f5-0af1f6144456",
      last_updated_at: "2026-03-21T02:00:00.000Z"
    });

    await repo.create({ proposal: firstPending, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });
    await repo.create({ proposal: accepted, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });
    await repo.create({ proposal: secondPending, workspace_id: "workspace-1", run_id: "run-2", target_object_kind: "memory_entry" });
    await repo.create({
      proposal: createProposal({
        runtime_id: "27a93344-32c1-48cc-80c9-f41a898f2ade",
        proposal_id: "27a93344-32c1-48cc-80c9-f41a898f2ade"
      }),
      workspace_id: "workspace-2",
      run_id: "run-3",
      target_object_kind: "memory_entry"
    });

    const allRows = await repo.findByWorkspaceId("workspace-1");
    expect(allRows.map((row) => row.proposal_id)).toEqual([
      secondPending.proposal_id,
      accepted.proposal_id,
      firstPending.proposal_id
    ]);

    const pendingRows = await repo.findPending("workspace-1");
    expect(pendingRows.map((row) => row.proposal_id)).toEqual([
      secondPending.proposal_id,
      firstPending.proposal_id
    ]);

    const allPage = await repo.findByWorkspaceId("workspace-1", { limit: 1, offset: 1 });
    expect(allPage.map((row) => row.proposal_id)).toEqual([accepted.proposal_id]);
    await expect(repo.countByWorkspaceId("workspace-1")).resolves.toBe(3);

    const pendingPage = await repo.findPending("workspace-1", { limit: 1, offset: 1 });
    expect(pendingPage.map((row) => row.proposal_id)).toEqual([firstPending.proposal_id]);
    await expect(repo.countPending("workspace-1")).resolves.toBe(2);
  });

  it("counts pending memory-target proposal edges independently of pending summary limits", async () => {
    const { repo } = createRepo();
    const firstTarget = "11111111-1111-4111-8111-111111111111";
    const secondTarget = "22222222-2222-4222-8222-222222222222";

    await repo.create({
      proposal: createProposal({
        runtime_id: "33333333-3333-4333-8333-333333333333",
        proposal_id: "33333333-3333-4333-8333-333333333333",
        derived_from: firstTarget
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "44444444-4444-4444-8444-444444444444",
        proposal_id: "44444444-4444-4444-8444-444444444444",
        derived_from: secondTarget
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "55555555-5555-4555-8555-555555555555",
        proposal_id: "55555555-5555-4555-8555-555555555555",
        derived_from: firstTarget,
        resolution_state: "accepted"
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "66666666-6666-4666-8666-666666666666",
        proposal_id: "66666666-6666-4666-8666-666666666666",
        derived_from: firstTarget
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "synthesis_capsule"
    });

    await expect(
      repo.countPendingMemoryTargetEdges("workspace-1", [firstTarget, secondTarget])
    ).resolves.toBe(2);
    await expect(repo.countPendingMemoryTargetEdges("workspace-1", [firstTarget])).resolves.toBe(1);
  });

  it("finds only pending bankruptcy proposals for a run", async () => {
    const { repo } = createRepo();
    const latestBankruptcy = createProposal({
      runtime_id: "7c5f7d02-c989-4d83-9b88-4252d76776f2",
      proposal_id: "7c5f7d02-c989-4d83-9b88-4252d76776f2",
      dossier_ref: "dossier-2",
      last_updated_at: "2026-03-21T04:00:00.000Z"
    });

    await repo.create({
      proposal: createProposal({
        runtime_id: "1a111111-1111-4111-8111-111111111111",
        proposal_id: "1a111111-1111-4111-8111-111111111111",
        dossier_ref: "dossier-1",
        last_updated_at: "2026-03-21T03:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "2b222222-2222-4222-8222-222222222222",
        proposal_id: "2b222222-2222-4222-8222-222222222222",
        dossier_ref: null,
        last_updated_at: "2026-03-21T05:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "3c333333-3333-4333-8333-333333333333",
        proposal_id: "3c333333-3333-4333-8333-333333333333",
        dossier_ref: "dossier-3",
        resolution_state: "accepted",
        last_updated_at: "2026-03-21T06:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: latestBankruptcy,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "4d444444-4444-4444-8444-444444444444",
        proposal_id: "4d444444-4444-4444-8444-444444444444",
        dossier_ref: "dossier-other-run",
        last_updated_at: "2026-03-21T07:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-2",
      target_object_kind: "memory_entry"
    });

    await expect(repo.findPendingByRunId("run-1")).resolves.toEqual(latestBankruptcy);
    await expect(repo.findPendingByRunId("run-404")).resolves.toBeNull();
  });

  it("updates proposal resolution state", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });

    const updated = await repo.updateResolution(
      proposal.proposal_id,
      "accepted",
      "2026-03-21T03:00:00.000Z"
    );

    expect(updated.resolution_state).toBe("accepted");
    expect(updated.last_updated_at).toBe("2026-03-21T03:00:00.000Z");
  });

  it("updates pending proposal resolution only once", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });

    const updated = await repo.updatePendingResolution(
      proposal.proposal_id,
      "accepted",
      "2026-03-21T03:00:00.000Z"
    );

    expect(updated.resolution_state).toBe("accepted");
    await expect(
      repo.updatePendingResolution(proposal.proposal_id, "rejected", "2026-03-21T04:00:00.000Z")
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "accepted",
      last_updated_at: "2026-03-21T03:00:00.000Z"
    });
  });

  it("atomically stores pending proposal resolution with review events", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });

    const result = await repo.updatePendingResolutionWithEvents(
      proposal.proposal_id,
      "accepted",
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal)
    );

    expect(result.proposal.resolution_state).toBe("accepted");
    expect(result.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    ]);
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(3);

    await expect(
      repo.updatePendingResolutionWithEvents(
        proposal.proposal_id,
        "rejected",
        "2026-03-21T04:00:00.000Z",
        createReviewEvents(proposal)
      )
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(3);
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "accepted",
      last_updated_at: "2026-03-21T03:00:00.000Z"
    });
  });

  it("atomically stores proposal row and creation events in one transaction", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();

    const result = await repo.createProposalWithEvents(
      { proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" },
      createCreationEvents(proposal)
    );

    expect(result.proposal).toEqual(proposal);
    expect(result.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED
    ]);
    expect(result.events[0]?.revision).toBe(0);
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(1);
    await expect(repo.findById(proposal.proposal_id)).resolves.toEqual(proposal);
  });

});
