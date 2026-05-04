import { afterEach, describe, expect, it } from "vitest";
import { MemoryGovernanceEventType, RetentionPolicy, type Proposal } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../db.js";
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

describe("SqliteProposalRepo", () => {
  it("creates and loads proposal by proposal id", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();

    await expect(
      repo.create({
        proposal,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    ).resolves.toEqual(proposal);

    await expect(repo.findById(proposal.proposal_id)).resolves.toEqual(proposal);
    await expect(repo.findScopedById(proposal.proposal_id)).resolves.toEqual({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1"
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

    await repo.create({ proposal: firstPending, workspace_id: "workspace-1", run_id: "run-1" });
    await repo.create({ proposal: accepted, workspace_id: "workspace-1", run_id: "run-1" });
    await repo.create({ proposal: secondPending, workspace_id: "workspace-1", run_id: "run-2" });
    await repo.create({
      proposal: createProposal({
        runtime_id: "27a93344-32c1-48cc-80c9-f41a898f2ade",
        proposal_id: "27a93344-32c1-48cc-80c9-f41a898f2ade"
      }),
      workspace_id: "workspace-2",
      run_id: "run-3"
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
      run_id: "run-1"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "2b222222-2222-4222-8222-222222222222",
        proposal_id: "2b222222-2222-4222-8222-222222222222",
        dossier_ref: null,
        last_updated_at: "2026-03-21T05:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-1"
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
      run_id: "run-1"
    });
    await repo.create({
      proposal: latestBankruptcy,
      workspace_id: "workspace-1",
      run_id: "run-1"
    });
    await repo.create({
      proposal: createProposal({
        runtime_id: "4d444444-4444-4444-8444-444444444444",
        proposal_id: "4d444444-4444-4444-8444-444444444444",
        dossier_ref: "dossier-other-run",
        last_updated_at: "2026-03-21T07:00:00.000Z"
      }),
      workspace_id: "workspace-1",
      run_id: "run-2"
    });

    await expect(repo.findPendingByRunId("run-1")).resolves.toEqual(latestBankruptcy);
    await expect(repo.findPendingByRunId("run-404")).resolves.toBeNull();
  });

  it("updates proposal resolution state", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1" });

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
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1" });

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
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1" });

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
      { proposal, workspace_id: "workspace-1", run_id: "run-1" },
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

  it("rolls back creation events when the proposal row insert fails", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal();

    // Pre-insert the proposal row so the inner INSERT collides on PRIMARY KEY (proposal_id).
    await repo.create({ proposal, workspace_id: "workspace-1", run_id: "run-1" });
    expect(countProposalEvents(database, proposal.proposal_id)).toBe(0);

    await expect(
      repo.createProposalWithEvents(
        {
          proposal: createProposal({ last_updated_at: "2026-03-22T00:00:00.000Z" }),
          workspace_id: "workspace-1",
          run_id: "run-1"
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
      run_id: "run-1"
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
