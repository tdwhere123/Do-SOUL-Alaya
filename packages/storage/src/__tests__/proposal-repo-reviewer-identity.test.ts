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

// A1 (HITL daemon backbone) — the proposals row gains:
//   reviewer_identity (NULL until reviewed)
//   target_object_kind ('memory_entry' default for back-compat)
//   proposed_change_summary (text)
//   created_at (TEXT; backfilled from last_updated_at for pre-A1 rows)
// findPending and findScopedById now project these so the
// soul.list_pending_proposals MCP tool and the Inspector can show a
// HITL queue without joining event_log payloads.
describe("proposal-repo reviewer_identity (A1)", () => {
  it("persists reviewer_identity through updatePendingResolutionWithEvents", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Switch to pnpm",
      created_at: "2026-04-30T00:00:00.000Z"
    });

    await repo.updatePendingResolutionWithEvents(
      proposal.proposal_id,
      "accepted",
      "2026-04-30T01:00:00.000Z",
      createReviewEvents(proposal),
      { reviewerIdentity: "user:alice" }
    );

    const scoped = await repo.findScopedById(proposal.proposal_id);
    expect(scoped).not.toBeNull();
    expect(scoped?.reviewer_identity).toBe("user:alice");
  });

  it("findPending projects target_object_kind, summary, and created_at", async () => {
    const { repo } = createRepo();
    const proposal = createProposal();
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "Switch to pnpm",
      created_at: "2026-04-30T00:00:00.000Z"
    });

    const summaries = await repo.findPendingSummaries("workspace-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      proposal_id: proposal.proposal_id,
      target_object_id: proposal.derived_from,
      target_object_kind: "memory_entry",
      created_at: "2026-04-30T00:00:00.000Z",
      proposed_change_summary: "Switch to pnpm"
    });
  });

  it("findPendingSummaries respects an optional since filter", async () => {
    const { repo } = createRepo();
    const earlier = createProposal({
      runtime_id: "11111111-1111-4111-8111-111111111111",
      proposal_id: "11111111-1111-4111-8111-111111111111"
    });
    const later = createProposal({
      runtime_id: "22222222-2222-4222-8222-222222222222",
      proposal_id: "22222222-2222-4222-8222-222222222222"
    });
    await repo.create({
      proposal: earlier,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "earlier",
      created_at: "2026-04-30T00:00:00.000Z"
    });
    await repo.create({
      proposal: later,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "later",
      created_at: "2026-04-30T05:00:00.000Z"
    });

    const filtered = await repo.findPendingSummaries("workspace-1", {
      since: "2026-04-30T03:00:00.000Z"
    });
    expect(filtered.map((row) => row.proposal_id)).toEqual([later.proposal_id]);
  });

  it("findPendingSummaries respects an optional limit", async () => {
    const { repo } = createRepo();
    for (let index = 0; index < 3; index += 1) {
      const proposalId = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`;
      await repo.create({
        proposal: createProposal({ runtime_id: proposalId, proposal_id: proposalId }),
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "memory_entry",
        proposed_change_summary: `change ${index}`,
        created_at: `2026-04-30T0${index}:00:00.000Z`
      });
    }

    const limited = await repo.findPendingSummaries("workspace-1", { limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

function createRepo(): { readonly repo: SqliteProposalRepo; readonly database: StorageDatabase } {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return { repo: new SqliteProposalRepo(database), database };
}

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
    last_updated_at: "2026-04-30T00:00:00.000Z",
    ...overrides
  };
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
    }
  ];
}
