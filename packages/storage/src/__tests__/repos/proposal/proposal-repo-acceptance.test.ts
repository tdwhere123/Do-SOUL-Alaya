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

describe("SqliteProposalRepo acceptance workflows", () => {
  it("atomically accepts a proposal, applies memory changes, and writes audit events", async () => {
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

    const result = await repo.acceptPendingMemoryUpdateWithEvents(
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
    );

    expect(result.proposal.resolution_state).toBe("accepted");
    expect(result.memory).toMatchObject({
      object_id: proposal.derived_from,
      content: "Use pnpm for workspace commands.",
      updated_at: "2026-03-21T03:00:00.000Z"
    });
    expect(result.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      MemoryGovernanceEventType.SOUL_MEMORY_UPDATED
    ]);
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(3);
    expect(countMemoryUpdatedEvents(database, proposal.derived_from ?? "")).toBe(1);
    const memoryEvent = result.events.at(-1);
    expect(memoryEvent).toMatchObject({
      event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      entity_type: "memory_entry",
      entity_id: proposal.derived_from,
      caused_by: `proposal_accept:${proposal.proposal_id}`
    });
    expect(memoryEvent?.payload_json).toMatchObject({
      updated_fields: ["content"]
    });
  });

  it("atomically revokes green mapping when accepted evidence changes lose every prior anchor", async () => {
    const { repo, database } = createRepo();
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const greenRepo = new SqliteGreenStatusRepo(database);
    const proposal = createProposal();
    await memoryRepo.create(createMemoryEntry({ evidence_refs: ["evidence-1"] }));
    await greenRepo.upsert(createGreenStatus());
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Replace evidence anchors",
      proposed_changes: { evidence_refs: ["evidence-2"] }
    });

    const result = await repo.acceptPendingMemoryUpdateWithEvents(
      proposal.proposal_id,
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal),
      {
        target_object_id: proposal.derived_from ?? "",
        workspace_id: "workspace-1",
        proposed_changes: { evidence_refs: ["evidence-2"] },
        updated_at: "2026-03-21T03:00:00.000Z",
        caused_by: `proposal_accept:${proposal.proposal_id}`
      },
      { reviewerIdentity: "user:alice" }
    );

    expect(result.events.map((event) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      GreenGovernanceEventType.SOUL_GREEN_PIERCED
    ]);
    await expect(greenRepo.findByTargetObjectId(proposal.derived_from ?? "")).resolves.toMatchObject({
      green_state: GreenState.REVOKED,
      revoke_reason: RevokeReason.MAPPING_REVOKED,
      updated_at: "2026-03-21T03:00:00.000Z"
    });
    expect(countGreenPiercedEvents(database, proposal.derived_from ?? "")).toBe(1);
  });

  it("accepts Inspector trust and retire proposals only through audited apply", async () => {
    const { repo, database } = createRepo();
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const proposal = createProposal({
      proposal_id: "44444444-4444-4444-8444-444444444444",
      runtime_id: "44444444-4444-4444-8444-444444444444"
    });
    await memoryRepo.create(createMemoryEntry());
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Retire stale memory",
      proposed_changes: {
        confidence: 0.4,
        retention_state: "tombstoned",
        storage_tier: "cold"
      }
    });

    await expect(memoryRepo.findById(proposal.derived_from ?? "")).resolves.toMatchObject({
      confidence: 1,
      retention_state: "working",
      storage_tier: "hot"
    });

    const result = await repo.acceptPendingMemoryUpdateWithEvents(
      proposal.proposal_id,
      "2026-03-21T03:00:00.000Z",
      createReviewEvents(proposal),
      {
        target_object_id: proposal.derived_from ?? "",
        workspace_id: "workspace-1",
        proposed_changes: {
          confidence: 0.4,
          retention_state: "tombstoned",
          storage_tier: "cold"
        },
        updated_at: "2026-03-21T03:00:00.000Z",
        caused_by: `proposal_accept:${proposal.proposal_id}`
      },
      { reviewerIdentity: "user:alice" }
    );

    expect(result.memory).toMatchObject({
      confidence: 0.4,
      retention_state: "tombstoned",
      storage_tier: "cold"
    });
    expect(result.events.at(-1)?.event_type).toBe(MemoryGovernanceEventType.SOUL_MEMORY_UPDATED);
    expect(result.events.at(-1)?.payload_json).toMatchObject({
      updated_fields: ["storage_tier", "confidence", "retention_state"]
    });
    expect(countMemoryUpdatedEvents(database, proposal.derived_from ?? "")).toBe(1);
  });

  it("rejects accepting one proposal while applying a different memory target", async () => {
    const { repo, database } = createRepo();
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const firstMemory = createMemoryEntry();
    const secondMemory = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "Keep npm for workspace commands."
    });
    const firstProposal = createProposal({
      proposal_id: "22222222-2222-4222-8222-222222222222",
      runtime_id: "22222222-2222-4222-8222-222222222222",
      derived_from: firstMemory.object_id,
      recommended_option_id: "22222222-2222-4222-8222-222222222223"
    });
    const secondProposal = createProposal({
      proposal_id: "33333333-3333-4333-8333-333333333333",
      runtime_id: "33333333-3333-4333-8333-333333333333",
      derived_from: secondMemory.object_id,
      recommended_option_id: "33333333-3333-4333-8333-333333333334"
    });
    await memoryRepo.create(firstMemory);
    await memoryRepo.create(secondMemory);
    await repo.create({
      proposal: firstProposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Apply accepted patch",
      proposed_changes: { content: "Use pnpm for workspace commands." }
    });
    await repo.create({
      proposal: secondProposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Apply accepted patch",
      proposed_changes: { content: "Use yarn for workspace commands." }
    });

    await expect(
      repo.acceptPendingMemoryUpdateWithEvents(
        firstProposal.proposal_id,
        "2026-03-21T03:00:00.000Z",
        createReviewEvents(firstProposal),
        {
          target_object_id: secondMemory.object_id,
          workspace_id: "workspace-1",
          proposed_changes: { content: "Use yarn for workspace commands." },
          updated_at: "2026-03-21T03:00:00.000Z",
          caused_by: `proposal_accept:${firstProposal.proposal_id}`
        },
        { reviewerIdentity: "user:alice" }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(countProposalEvents(database, firstProposal.proposal_id)).toBe(0);
    expect(countMemoryUpdatedEvents(database, secondMemory.object_id)).toBe(0);
    await expect(repo.findById(firstProposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
    await expect(repo.findById(secondProposal.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending",
      last_updated_at: "2026-03-21T00:00:00.000Z"
    });
    await expect(memoryRepo.findById(firstMemory.object_id)).resolves.toMatchObject({
      content: "Use npm for workspace commands.",
      updated_at: "2026-03-21T00:00:00.000Z"
    });
    await expect(memoryRepo.findById(secondMemory.object_id)).resolves.toMatchObject({
      content: "Keep npm for workspace commands.",
      updated_at: "2026-03-21T00:00:00.000Z"
    });
  });


});
