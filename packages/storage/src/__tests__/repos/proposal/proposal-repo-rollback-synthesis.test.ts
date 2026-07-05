import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryGovernanceEventType} from "@do-soul/alaya-protocol";
import { SqliteMemoryEntryRepo } from "../../../repos/memory-entry/index.js";

import {
  countMemoryUpdatedEvents,
  countProposalEvents,
  countSynthesisCapsules,
  countSynthesisCreatedEvents,
  createCreationEvents,
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

describe("SqliteProposalRepo rollback and synthesis workflows", () => {
  it("rejects accepting a proposal with caller-supplied proposed changes that differ from storage", async () => {
    const { repo, database } = createRepo();
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const proposal = createProposal();
    await memoryRepo.create(createMemoryEntry());
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Apply accepted patch",
      proposed_changes: { content: "Use pnpm for workspace commands." }
    });

    await expect(
      repo.acceptPendingMemoryUpdateWithEvents(
        proposal.proposal_id,
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(proposal),
        {
          target_object_id: proposal.derived_from ?? "",
          workspace_id: "workspace-1",
          proposed_changes: { content: "Use yarn for workspace commands." },
          updated_at: "2026-03-21T03:00:00.000Z",
          caused_by: `proposal_accept:${proposal.proposal_id}`
        },
        { reviewerIdentity: "user:alice" }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
    expect(countMemoryUpdatedEvents(database, proposal.derived_from ?? "")).toBe(0);
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
    await expect(memoryRepo.findById(proposal.derived_from ?? "")).resolves.toMatchObject({
      content: "Use npm for workspace commands.",
      updated_at: "2026-03-21T00:00:00.000Z"
    });
  });

  it("rolls back proposal review events and resolution when accepted memory apply fails", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Apply accepted patch",
      proposed_changes: { content: "Use pnpm for workspace commands." }
    });

    await expect(
      repo.acceptPendingMemoryUpdateWithEvents(
        proposal.proposal_id,
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(proposal),
        {
          target_object_id: proposal.derived_from ?? "",
          workspace_id: "workspace-1",
          proposed_changes: { content: "Use pnpm for workspace commands." },
          updated_at: "2026-03-21T03:00:00.000Z",
          caused_by: `proposal_accept:${proposal.proposal_id}`
        },
        { reviewerIdentity: "user:alice" }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
    expect(countMemoryUpdatedEvents(database, proposal.derived_from ?? "")).toBe(0);
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
  });

  it("rolls back proposal resolution when a transaction mutation fails", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });

    await expect(
      repo.updatePendingResolutionWithEvents(
        proposal.proposal_id,
        "accepted",
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(proposal),
        {
          reviewerIdentity: "user:alice",
          applySynchronousResolutionMutation: () => {
            throw new Error("karma transition failed");
          }
        }
      )
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });

    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
  });

  it("rolls back creation events when the proposal row insert fails", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();

    // Pre-insert the proposal row so the inner INSERT collides on PRIMARY KEY (proposal_id).
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1", target_object_kind: "memory_entry" });
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);

    await expect(
      repo.createProposalWithEvents(
        {
          proposal: createProposal({ last_updated_at: "2026-03-22T00:00:00.000Z" }),
          workspace_id: "workspace-1",
          run_id: "run-1",
          target_object_kind: "memory_entry"
        },
        createCreationEvents(proposal)
      )
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });

    // Transaction should have rolled back the EventLog draft so no ghost events remain.
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
    await expect(repo.findById(proposal.proposal_id)).resolves.toMatchObject({
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
  });

  it("throws not found when updating a missing proposal", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();

    await expect(
      repo.updateResolution("missing-proposal", "accepted", "2026-03-21T03:00:00.000Z")
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await expect(
      repo.updatePendingResolution("missing-proposal", "accepted", "2026-03-21T03:00:00.000Z")
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await expect(
      repo.updatePendingResolutionWithEvents(
        "missing-proposal",
        "accepted",
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(proposal)
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);
  });

  it("returns immutable proposals", async () => {
    const { repo } = createRepo();
    const created = await repo.create({
      proposal: createProposal(),
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });

    expect(() => {
      (created as { resolution_state: string }).resolution_state = "accepted";
    }).toThrow(TypeError);
  });

  it("atomically accepts a librarian synthesis proposal, inserts the capsule, and writes audit events", async () => {
    const { repo, database } = createRepo();
    const proposal = createSynthesisProposal({ dossier_ref: "librarian.synthesis" });
    const capsule = createSynthesisCapsule();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: null,
      target_object_kind: "memory_entry",
      proposed_change_summary: "Synthesis cluster"
    });

    const result = await repo.acceptPendingSynthesisCreateWithEvents(
      proposal.proposal_id,
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal),
      {
        workspace_id: "workspace-1",
        capsule,
        caused_by: `proposal_accept:${proposal.proposal_id}`
      },
      { reviewerIdentity: "user:alice" }
    );

    expect(result.proposal.resolution_state).toBe("accepted");
    expect(result.synthesis).toEqual(capsule);
    expect(result.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED
    ]);
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(3);
    expect(countSynthesisCreatedEvents(database, capsule.object_id)).toBe(1);
    expect(countSynthesisCapsules(database, capsule.object_id)).toBe(1);
    const synthesisEvent = result.events.at(-1);
    expect(synthesisEvent).toMatchObject({
      event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
      entity_type: "synthesis_capsule",
      entity_id: capsule.object_id,
      caused_by: capsule.created_by
    });
  });

  it("atomically accepts a bootstrapping synthesis_candidate proposal", async () => {
    const { repo, database } = createRepo();
    const proposal = createSynthesisProposal({
      dossier_ref: "bootstrapping.synthesis_candidate"
    });
    const capsule = createSynthesisCapsule({ evidence_refs: [] });
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: null,
      target_object_kind: "memory_entry"
    });

    const result = await repo.acceptPendingSynthesisCreateWithEvents(
      proposal.proposal_id,
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal),
      {
        workspace_id: "workspace-1",
        capsule,
        caused_by: `proposal_accept:${proposal.proposal_id}`
      }
    );

    expect(result.proposal.resolution_state).toBe("accepted");
    expect(countSynthesisCapsules(database, capsule.object_id)).toBe(1);
  });

  it("rejects a synthesis proposal without inserting any capsule", async () => {
    const { repo, database } = createRepo();
    const proposal = createSynthesisProposal({ dossier_ref: "librarian.synthesis" });
    const capsule = createSynthesisCapsule();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: null,
      target_object_kind: "memory_entry"
    });

    const result = await repo.updatePendingResolutionWithEvents(
      proposal.proposal_id,
      "rejected",
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal),
      { reviewerIdentity: "user:alice" }
    );

    expect(result.proposal.resolution_state).toBe("rejected");
    expect(countSynthesisCapsules(database, capsule.object_id)).toBe(0);
    expect(countSynthesisCreatedEvents(database, capsule.object_id)).toBe(0);
  });

  it("rejects a synthesis create that does not match the proposal dossier", async () => {
    const { repo, database } = createRepo();
    // A plain memory_entry proposal (dossier_ref=null) must not be acceptable
    // through the synthesis-create path.
    const proposal = createProposal();
    const capsule = createSynthesisCapsule();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry"
    });

    await expect(
      repo.acceptPendingSynthesisCreateWithEvents(
        proposal.proposal_id,
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(proposal),
        {
          workspace_id: "workspace-1",
          capsule,
          caused_by: `proposal_accept:${proposal.proposal_id}`
        }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(countSynthesisCapsules(database, capsule.object_id)).toBe(0);
  });
});
