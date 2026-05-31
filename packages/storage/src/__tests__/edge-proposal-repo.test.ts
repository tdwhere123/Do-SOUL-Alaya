import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteEdgeProposalRepo } from "../repos/edge-proposal-repo.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();
const MEMORY_1 = "00000000-0000-4000-8000-000000000001";
const MEMORY_2 = "00000000-0000-4000-8000-000000000002";
const MEMORY_3 = "00000000-0000-4000-8000-000000000003";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqliteEdgeProposalRepo", () => {
  it("creates, filters, and reviews pending edge proposals", async () => {
    const { repo } = await createRepo();

    const first = repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.create(createProposalInput("proposal-2", MEMORY_2, MEMORY_3, "contradicts"));

    expect(first).toMatchObject({
      proposal_id: "proposal-1",
      status: "pending",
      reviewer_identity: null
    });
    expect(repo.findPendingDuplicate({
      workspaceId: "workspace-1",
      sourceMemoryId: MEMORY_1,
      targetMemoryId: MEMORY_2,
      edgeType: "recalls"
    })?.proposal_id).toBe("proposal-1");
    expect(repo.listPending("workspace-1", { edge_type: "recalls" }).map((row) => row.proposal_id)).toEqual([
      "proposal-1"
    ]);

    const reviewed = repo.updateReview({
      proposalId: "proposal-1",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted by test",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });

    expect(reviewed).toMatchObject({
      proposal_id: "proposal-1",
      status: "accepted",
      reviewer_identity: "user:reviewer",
      review_reason: "accepted by test",
      updated_at: "2026-05-24T00:05:00.000Z"
    });
    expect(repo.listPending("workspace-1").map((row) => row.proposal_id)).toEqual(["proposal-2"]);
  });

  it("keeps one pending proposal per workspace/source/target/type", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));

    expect(() =>
      repo.create(createProposalInput("proposal-duplicate", MEMORY_1, MEMORY_2, "recalls"))
    ).toThrow("Failed to create edge proposal proposal-duplicate.");
  });

  it("fails closed when reviewing a non-pending proposal", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "rejected",
      reviewerIdentity: "user:reviewer",
      reviewReason: "first decision wins",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });

    expect(() =>
      repo.updateReview({
        proposalId: "proposal-1",
        status: "accepted",
        reviewerIdentity: "user:reviewer",
        reviewReason: "late accept",
        reviewedAt: "2026-05-24T00:06:00.000Z"
      })
    ).toThrow("Edge proposal is not pending: proposal-1 (rejected)");
  });

  // invariant (I1): a transient mint failure reconciles an accepted row back to
  // pending so it re-surfaces in listPending for operator retry. The partial
  // unique index on (workspace, source, target, type) WHERE status='pending'
  // must permit the revert because no other pending row holds the same tuple.
  it("reconciles a transient-failed accepted proposal back to pending (re-selectable)", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted then mint failed",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });
    expect(repo.listPending("workspace-1").map((row) => row.proposal_id)).toEqual([]);

    const reverted = repo.reconcileAfterMintFailure({
      proposalId: "proposal-1",
      fromStatus: "accepted",
      toStatus: "pending",
      reviewerIdentity: null,
      reviewReason: null,
      reviewedAt: "2026-05-24T00:06:00.000Z"
    });
    expect(reverted).toMatchObject({
      proposal_id: "proposal-1",
      status: "pending",
      reviewer_identity: null,
      review_reason: null,
      updated_at: "2026-05-24T00:06:00.000Z"
    });
    expect(repo.listPending("workspace-1").map((row) => row.proposal_id)).toEqual(["proposal-1"]);
  });

  // invariant (I1): a permanent anchor rejection reconciles an accepted row to
  // terminal rejected with the mint-failure review_reason; it leaves the
  // pending list so it can never become a retry poison pill.
  it("reconciles a permanent-rejected accepted proposal to terminal rejected (leaves pending list)", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "auto_accepted",
      reviewerIdentity: "system:auto_accept_policy",
      reviewReason: "auto-accepted by trigger floor policy",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });

    const rejected = repo.reconcileAfterMintFailure({
      proposalId: "proposal-1",
      fromStatus: "auto_accepted",
      toStatus: "rejected",
      reviewerIdentity: "system:auto_accept_policy",
      reviewReason: "auto-rejected: owed path mint permanently refused",
      reviewedAt: "2026-05-24T00:06:00.000Z"
    });
    expect(rejected).toMatchObject({
      proposal_id: "proposal-1",
      status: "rejected",
      reviewer_identity: "system:auto_accept_policy",
      review_reason: "auto-rejected: owed path mint permanently refused"
    });
    expect(repo.listPending("workspace-1").map((row) => row.proposal_id)).toEqual([]);
  });

  // invariant (I1): reconcile is CAS-gated on fromStatus, so a concurrent
  // decision cannot be clobbered. A reconcile against a row that is no longer in
  // fromStatus fails closed.
  it("fails closed when reconciling a proposal not in fromStatus", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "rejected",
      reviewerIdentity: "user:reviewer",
      reviewReason: "human rejected first",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });

    expect(() =>
      repo.reconcileAfterMintFailure({
        proposalId: "proposal-1",
        fromStatus: "accepted",
        toStatus: "pending",
        reviewerIdentity: null,
        reviewReason: null,
        reviewedAt: "2026-05-24T00:06:00.000Z"
      })
    ).toThrow("Edge proposal is not in accepted: proposal-1 (rejected)");
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteEdgeProposalRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "edge proposal run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await memoryRepo.create(createMemoryEntry(MEMORY_1));
  await memoryRepo.create(createMemoryEntry(MEMORY_2));
  await memoryRepo.create(createMemoryEntry(MEMORY_3));

  return {
    repo: new SqliteEdgeProposalRepo(database)
  };
}

function createProposalInput(
  proposalId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  edgeType: "recalls" | "contradicts"
) {
  return {
    proposal_id: proposalId,
    workspace_id: "workspace-1",
    source_memory_id: sourceMemoryId,
    target_memory_id: targetMemoryId,
    edge_type: edgeType,
    trigger_source: "recall_cross_link" as const,
    confidence: 0.5,
    reason: "test proposal",
    source_signal_id: null,
    run_id: "run-1",
    created_at: "2026-05-24T00:00:00.000Z",
    expires_at: null
  };
}

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    created_by: "edge-proposal-test",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: `memory ${objectId}`,
    domain_tags: ["test"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}
