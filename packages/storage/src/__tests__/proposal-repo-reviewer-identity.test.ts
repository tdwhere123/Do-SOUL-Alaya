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

  // A1 fix-loop (finding-3): the previous default of 'memory_entry' on
  // every create() mislabeled synthesis-derived and bankruptcy-derived
  // proposals in the Inspector queue. The repo now persists the
  // explicit target_object_kind, and findPendingSummaries surfaces it
  // verbatim. These tests assert that for the two non-memory_entry
  // creators the kind round-trips correctly.
  it("surfaces target_object_kind=synthesis_capsule for synthesis-derived rows (finding-3)", async () => {
    const { repo } = createRepo();
    const proposal = createProposal({
      runtime_id: "33333333-3333-4333-8333-333333333333",
      proposal_id: "33333333-3333-4333-8333-333333333333"
    });
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-synth",
      target_object_kind: "synthesis_capsule",
      proposed_change_summary: "Promote synthesis capsule X",
      created_at: "2026-04-30T01:00:00.000Z"
    });

    const summaries = await repo.findPendingSummaries("workspace-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      proposal_id: proposal.proposal_id,
      target_object_kind: "synthesis_capsule",
      proposed_change_summary: "Promote synthesis capsule X"
    });
  });

  it("surfaces target_object_kind=bankruptcy_dossier for bankruptcy-derived rows (finding-3)", async () => {
    const { repo } = createRepo();
    const proposal = createProposal({
      runtime_id: "44444444-4444-4444-8444-444444444444",
      proposal_id: "44444444-4444-4444-8444-444444444444"
    });
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-bk",
      target_object_kind: "bankruptcy_dossier",
      proposed_change_summary: "Bankruptcy resolution: dossier-1",
      created_at: "2026-04-30T02:00:00.000Z"
    });

    const summaries = await repo.findPendingSummaries("workspace-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      proposal_id: proposal.proposal_id,
      target_object_kind: "bankruptcy_dossier",
      proposed_change_summary: "Bankruptcy resolution: dossier-1"
    });
  });

  // A1 fix-loop (finding-5): every code path leading to
  // resolution_state ∈ ('accepted','rejected') writes a non-null
  // reviewer_identity. This contract test exercises both write paths
  // (legacy updateResolution + new updatePendingResolutionWithEvents)
  // and asserts the SQL-level invariant.
  it("every accepted/rejected proposals row carries a non-null reviewer_identity (finding-5 contract)", async () => {
    const { repo, database } = createRepo();

    const acceptedThroughLegacy = createProposal({
      runtime_id: "55555555-5555-4555-8555-555555555555",
      proposal_id: "55555555-5555-4555-8555-555555555555"
    });
    await repo.create({
      proposal: acceptedThroughLegacy,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "synthesis_capsule",
      proposed_change_summary: "legacy path",
      created_at: "2026-04-30T03:00:00.000Z"
    });
    await repo.updateResolution(
      acceptedThroughLegacy.proposal_id,
      "accepted",
      "2026-04-30T03:30:00.000Z",
      "user:legacy-reviewer"
    );

    const rejectedThroughEvents = createProposal({
      runtime_id: "66666666-6666-4666-8666-666666666666",
      proposal_id: "66666666-6666-4666-8666-666666666666"
    });
    await repo.create({
      proposal: rejectedThroughEvents,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "events path",
      created_at: "2026-04-30T04:00:00.000Z"
    });
    await repo.updatePendingResolutionWithEvents(
      rejectedThroughEvents.proposal_id,
      "rejected",
      "2026-04-30T04:30:00.000Z",
      createReviewEvents(rejectedThroughEvents),
      { reviewerIdentity: "user:events-reviewer" }
    );

    // SQL-level audit: scan the proposals table directly.
    const resolvedRows = database.connection
      .prepare(
        `SELECT proposal_id, resolution_state, reviewer_identity
         FROM proposals
         WHERE resolution_state IN ('accepted','rejected')`
      )
      .all() as ReadonlyArray<{
        readonly proposal_id: string;
        readonly resolution_state: string;
        readonly reviewer_identity: string | null;
      }>;

    expect(resolvedRows).toHaveLength(2);
    for (const row of resolvedRows) {
      expect(row.reviewer_identity).not.toBeNull();
      expect((row.reviewer_identity ?? "").length).toBeGreaterThan(0);
    }
  });

  // A1 fix-loop (finding-7): two-tx race against the same proposal —
  // exactly one writer wins; the other receives a CONFLICT; event_log
  // contains only the winning side's events (count == 3, not 6).
  // Documents the v0.1 contract: "explicit CONFLICT + retry" (Q3).
  it("second concurrent reviewer loses with CONFLICT and event_log contains only the winner (finding-7)", async () => {
    const { repo, database } = createRepo();
    const proposal = createProposal({
      runtime_id: "77777777-7777-4777-8777-777777777777",
      proposal_id: "77777777-7777-4777-8777-777777777777"
    });
    await repo.create({
      proposal,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_kind: "memory_entry",
      proposed_change_summary: "race candidate",
      created_at: "2026-04-30T05:00:00.000Z"
    });

    // Two simultaneous reviewers. better-sqlite3 transactions are
    // synchronous, so the second tx will see a non-pending row when it
    // runs and report changes === 0 → CONFLICT. Promise.all preserves
    // the "happens at the same moment from JS's point of view"
    // semantics that production CLI/Inspector/MCP-attach concurrency
    // would produce.
    const winnerEvents = makeReviewEventsFor(proposal, "user:winner");
    const loserEvents = makeReviewEventsFor(proposal, "user:loser");
    const results = await Promise.allSettled([
      repo.updatePendingResolutionWithEvents(
        proposal.proposal_id,
        "accepted",
        "2026-04-30T05:30:00.000Z",
        winnerEvents,
        { reviewerIdentity: "user:winner" }
      ),
      repo.updatePendingResolutionWithEvents(
        proposal.proposal_id,
        "rejected",
        "2026-04-30T05:30:01.000Z",
        loserEvents,
        { reviewerIdentity: "user:loser" }
      )
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });

    // event_log row count for this proposal must be exactly 3 — the
    // losing transaction rolled back its 3 inserts.
    const eventRows = database.connection
      .prepare(
        `SELECT caused_by FROM event_log
         WHERE entity_type = 'proposal' AND entity_id = ?`
      )
      .all(proposal.proposal_id) as ReadonlyArray<{ readonly caused_by: string | null }>;
    expect(eventRows).toHaveLength(3);
    // All three rows belong to the same winner.
    const causedBySet = new Set(eventRows.map((row) => row.caused_by));
    expect(causedBySet.size).toBe(1);
  });
});

function makeReviewEventsFor(
  proposal: Proposal,
  reviewerIdentity: string
): readonly ProposalResolutionEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: reviewerIdentity,
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
      caused_by: reviewerIdentity,
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1",
        from_state: "pending",
        to_state: "accepted",
        reason_code: "accept",
        caused_by: "review",
        evidence_refs: null,
        occurred_at: "2026-04-30T05:30:00.000Z"
      }
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: reviewerIdentity,
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1",
        from_state: "pending",
        to_state: "accepted",
        reason_code: "accept",
        caused_by: "review",
        evidence_refs: null,
        occurred_at: "2026-04-30T05:30:00.000Z"
      }
    }
  ];
}

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
