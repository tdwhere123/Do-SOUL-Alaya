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
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteEdgeProposalRepo } from "../repos/edge-proposal-repo.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqlitePathRelationRepo } from "../repos/path-relation-repo.js";
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

  // invariant (FIX-1): reverting an accepted row to pending collides with
  // idx_edge_proposals_pending_unique when a duplicate pending re-proposal (P2)
  // already holds the same (workspace, source, target, type) tuple. The repo
  // catches the SQLITE_CONSTRAINT and falls back to terminal rejected
  // (superseded) rather than letting it escape and roll back the caller's
  // transaction. The reconcile still returns the moved row.
  it("reconciles to terminal rejected (superseded) when revert-to-pending collides with a duplicate pending row", async () => {
    const { repo } = await createRepo();
    // P1 accepted, P2 freshly pending for the same tuple (P1's pending slot was
    // free while it sat accepted, so create did not dedupe against it).
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted then mint failed",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });
    repo.create(createProposalInput("proposal-2", MEMORY_1, MEMORY_2, "recalls"));

    const reconciled = repo.reconcileAfterMintFailure({
      proposalId: "proposal-1",
      fromStatus: "accepted",
      toStatus: "pending",
      reviewerIdentity: null,
      reviewReason: null,
      reviewedAt: "2026-05-24T00:06:00.000Z",
      supersededReviewerIdentity: "system:edge_proposal_mint_reconcile",
      supersededReviewReason: "auto-rejected: superseded by duplicate pending re-proposal"
    });
    // P1 is terminal rejected (superseded), NOT stuck accepted and NOT a second
    // pending row that would itself violate the unique index.
    expect(reconciled).toMatchObject({
      proposal_id: "proposal-1",
      status: "rejected",
      reviewer_identity: "system:edge_proposal_mint_reconcile",
      review_reason: "auto-rejected: superseded by duplicate pending re-proposal"
    });
    expect(repo.findById("proposal-1")?.status).toBe("rejected");
    // P2 remains the single live pending row for the tuple.
    expect(repo.listPending("workspace-1").map((row) => row.proposal_id)).toEqual(["proposal-2"]);
  });

  // invariant (FIX-2): listAcceptedAwaitingPath returns accepted + auto_accepted
  // rows (crash-window orphans owing a path) oldest-first, bounded by limit, and
  // excludes pending / terminal rows.
  it("lists accepted and auto_accepted proposals awaiting a path, oldest first, bounded", async () => {
    const { repo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.create(createProposalInput("proposal-2", MEMORY_2, MEMORY_3, "recalls"));
    repo.create(createProposalInput("proposal-3", MEMORY_1, MEMORY_3, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });
    repo.updateReview({
      proposalId: "proposal-2",
      status: "auto_accepted",
      reviewerIdentity: "system:auto_accept_policy",
      reviewReason: "auto-accepted",
      reviewedAt: "2026-05-24T00:05:01.000Z"
    });
    // proposal-3 stays pending -> must be excluded.
    expect(repo.listAcceptedAwaitingPath("workspace-1", 32).map((row) => row.proposal_id)).toEqual([
      "proposal-1",
      "proposal-2"
    ]);
    expect(repo.listAcceptedAwaitingPath("workspace-1", 1).map((row) => row.proposal_id)).toEqual([
      "proposal-1"
    ]);
  });

  // invariant: a healthy accepted row whose owed path already landed is EXCLUDED
  // (the await-path predicate), so re-driving the sweep does not re-mint it.
  // The match mirrors the mint dedup: it is direction-insensitive and ignores
  // relation_kind, so a path minted source->target OR target->source, under a
  // different relation_kind, still excludes the proposal.
  it("excludes accepted proposals whose owed path already landed (either direction, any relation_kind)", async () => {
    const { repo, pathRepo } = await createRepo();
    repo.create(createProposalInput("proposal-1", MEMORY_1, MEMORY_2, "recalls"));
    repo.create(createProposalInput("proposal-2", MEMORY_2, MEMORY_3, "recalls"));
    repo.updateReview({
      proposalId: "proposal-1",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted",
      reviewedAt: "2026-05-24T00:05:00.000Z"
    });
    repo.updateReview({
      proposalId: "proposal-2",
      status: "auto_accepted",
      reviewerIdentity: "system:auto_accept_policy",
      reviewReason: "auto-accepted",
      reviewedAt: "2026-05-24T00:05:01.000Z"
    });
    // proposal-1's path landed in source->target order; proposal-2's landed in
    // REVERSE order under a different relation_kind. Both must drop out.
    mintObjectPath(pathRepo, 1, MEMORY_1, MEMORY_2);
    mintObjectPath(pathRepo, 2, MEMORY_3, MEMORY_2, {
      constitution: { relation_kind: "contradicts", why_this_relation_exists: ["x"] }
    });

    expect(repo.listAcceptedAwaitingPath("workspace-1", 32)).toEqual([]);
  });

  // invariant (regression for the cap-starvation hazard): a backlog of healthy
  // accepted rows (each already owning its path) MUST NOT consume the per-pass
  // cap and permanently hide a genuine crash-window orphan ordered after them.
  // Before the await-path filter, listAcceptedAwaitingPath returned EVERY
  // accepted row oldest-first, so a workspace with > cap healthy accepts plus a
  // later orphan re-selected the same healthy rows every pass (all minting
  // already_present) and never reached the orphan. With the filter the healthy
  // rows drop out, so even a tiny cap reaches the orphan in one pass.
  it("does not starve a genuine orphan behind more-than-cap healthy accepted rows", async () => {
    const CAP = 3;
    const HEALTHY = 5; // strictly greater than CAP
    const extraMemoryIds = Array.from({ length: HEALTHY * 2 + 2 }, (_, index) => objectId(index + 10));
    const { repo, pathRepo } = await createRepo(extraMemoryIds);

    // HEALTHY accepted rows, each on a distinct memory pair, ordered FIRST, each
    // already owning its minted path.
    for (let index = 0; index < HEALTHY; index += 1) {
      const proposalId = `healthy-${String(index).padStart(2, "0")}`;
      const source = extraMemoryIds[index * 2];
      const target = extraMemoryIds[index * 2 + 1];
      repo.create(
        createProposalInput(proposalId, source, target, "recalls", `2026-05-24T00:0${index}:00.000Z`)
      );
      repo.updateReview({
        proposalId,
        status: "accepted",
        reviewerIdentity: "user:reviewer",
        reviewReason: "accepted",
        reviewedAt: "2026-05-24T01:00:00.000Z"
      });
      mintObjectPath(pathRepo, index + 1, source, target);
    }

    // The genuine orphan: accepted-without-path, ordered AFTER every healthy row
    // (later created_at). No path is minted for it.
    const orphanSource = extraMemoryIds[HEALTHY * 2];
    const orphanTarget = extraMemoryIds[HEALTHY * 2 + 1];
    repo.create(
      createProposalInput("orphan-zz", orphanSource, orphanTarget, "recalls", "2026-05-24T09:00:00.000Z")
    );
    repo.updateReview({
      proposalId: "orphan-zz",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted then crashed before mint",
      reviewedAt: "2026-05-24T09:00:01.000Z"
    });

    // With the healthy rows excluded the orphan is the ONLY row owing a path, so
    // it is reached even though the cap is smaller than the healthy backlog.
    const awaiting = repo.listAcceptedAwaitingPath("workspace-1", CAP);
    expect(awaiting.map((row) => row.proposal_id)).toEqual(["orphan-zz"]);
  });

  // invariant (FIX-2): the await-path NOT EXISTS subquery must ride the
  // migration 048 anchor-key expression indexes, not degrade to a workspace
  // SCAN of path_relations per accepted proposal. A single OR across the
  // source-key and target-key expressions defeats the seek; the UNION ALL split
  // lets each orientation seek its own index. EXPLAIN QUERY PLAN runs over the
  // SQL the repo's OWN prepared statement carries (via .source) so a drift
  // between the indexed expression and the live statement fails this test.
  it("await-path subquery rides the anchor-key indexes (SEARCH path_relations, no workspace SCAN)", async () => {
    const { repo, pathRepo, database } = await createRepo();
    // Seed enough path_relations that a scan plan would be the costly path the
    // planner avoids only by riding the expression index.
    mintObjectPath(pathRepo, 1, MEMORY_1, MEMORY_2);
    mintObjectPath(pathRepo, 2, MEMORY_2, MEMORY_3);
    mintObjectPath(pathRepo, 3, MEMORY_1, MEMORY_3);

    const sql = repo.__awaitingPathSqlForTest();
    const plan = database.connection
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all("workspace-1", 32) as ReadonlyArray<{ readonly detail: string }>;
    const details = plan.map((step) => step.detail).join(" | ");

    // The subquery SEARCHes path_relations through one of the anchor-key indexes
    // with the anchor key BOUND (an index seek), not a residual filter.
    expect(
      plan.some(
        (step) =>
          step.detail.includes("SEARCH") &&
          step.detail.includes("path_relations") &&
          (step.detail.includes("idx_path_relations_source_anchor_key") ||
            step.detail.includes("idx_path_relations_target_anchor_key"))
      ),
      `expected an anchor-key index SEARCH of path_relations, got: ${details}`
    ).toBe(true);
    // path_relations is never SCANned (a workspace-scoped scan per proposal is
    // exactly the regression this guard catches).
    expect(
      plan.some((step) => step.detail.startsWith("SCAN") && step.detail.includes("path_relations")),
      `expected no SCAN of path_relations, got: ${details}`
    ).toBe(false);
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

async function createRepo(extraMemoryIds: readonly string[] = []): Promise<{
  readonly repo: SqliteEdgeProposalRepo;
  readonly pathRepo: SqlitePathRelationRepo;
  readonly database: ReturnType<typeof initDatabase>;
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
  for (const memoryId of extraMemoryIds) {
    await memoryRepo.create(createMemoryEntry(memoryId));
  }

  return {
    repo: new SqliteEdgeProposalRepo(database),
    pathRepo: new SqlitePathRelationRepo(database),
    database
  };
}

// Mirrors the accept mint's landing topology: a path_relations row whose
// source/target are object anchors on the two memory ids. The await-path query
// must treat a proposal owning such a path as no-longer-orphaned regardless of
// relation_kind / lifecycle. `index` keeps path_id unique per fixture.
function mintObjectPath(
  pathRepo: SqlitePathRelationRepo,
  index: number,
  sourceMemoryId: string,
  targetMemoryId: string,
  overrides: Partial<PathRelation> = {}
): void {
  const relation: PathRelation = {
    path_id: `path-${index}`,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: sourceMemoryId },
      target_anchor: { kind: "object", object_id: targetMemoryId }
    },
    constitution: {
      relation_kind: "recalls",
      why_this_relation_exists: ["edge proposal accepted"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides
  };
  pathRepo.create(relation);
}

function objectId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createProposalInput(
  proposalId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  edgeType: "recalls" | "contradicts",
  createdAt = "2026-05-24T00:00:00.000Z"
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
    created_at: createdAt,
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
