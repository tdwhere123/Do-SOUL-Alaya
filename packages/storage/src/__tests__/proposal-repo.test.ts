import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  RetentionPolicy,
  ScopeClass,
  SourceKind,
  StorageTier,
  type MemoryEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../db.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqliteProposalRepo, type ProposalResolutionEventInput } from "../repos/proposal-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    dossier_ref: null,
    recommended_option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    proposal_options: [
      {
        option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: "pending",
    last_updated_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use npm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

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
    // A1: ScopedProposal now carries reviewer_identity (null until reviewed).
    await expect(repo.findScopedById(proposal.proposal_id)).resolves.toEqual({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      reviewer_identity: null,
      reviewer_assignment: null,
      proposed_changes: null,
      target_baseline_updated_at: null
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
});

function createRepo(): { readonly repo: SqliteProposalRepo; readonly database: StorageDatabase } {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    repo: new SqliteProposalRepo(database),
    database
  };
}

function createCreationEvents(proposal: Proposal): readonly ProposalResolutionEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    }
  ];
}

function createReviewEvents(proposal: Proposal): readonly ProposalResolutionEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        from_state: "pending",
        to_state: "accepted"
      }
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        from_state: "pending",
        to_state: "accepted"
      }
    }
  ];
}

function countProposalEvents(database: StorageDatabase, proposalId: string): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_type = 'proposal' AND entity_id = ?")
    .get(proposalId) as { readonly count: number };
  return row.count;
}

function countMemoryUpdatedEvents(database: StorageDatabase, memoryId: string): number {
  const row = database.connection
    .prepare(
      "SELECT COUNT(*) AS count FROM event_log WHERE event_type = ? AND entity_type = 'memory_entry' AND entity_id = ?"
    )
    .get(MemoryGovernanceEventType.SOUL_MEMORY_UPDATED, memoryId) as { readonly count: number };
  return row.count;
}
