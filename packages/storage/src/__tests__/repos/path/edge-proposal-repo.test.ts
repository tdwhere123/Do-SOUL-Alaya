import { afterEach, describe, expect, it } from "vitest";
import {
  createProposalInput,
  createRepo,
  MEMORY_1,
  MEMORY_2,
  MEMORY_3,
  mintObjectPath,
  objectId,
  trackedDatabases
} from "./edge-proposal-repo-fixture.js";

const databases = trackedDatabases;

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

  // invariant: positive recalls-family identity is unordered across
  // recalls/co_recalled/shares_entity/signal_graph_ref. A healthy accepted
  // recalls row whose owed identity already landed is EXCLUDED so the repair
  // sweep does not re-mint it.
  it("excludes accepted recalls proposals already satisfied by the positive recalls family", async () => {
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
    // proposal-1's path landed source->target as recalls; proposal-2's landed
    // in REVERSE order as co_recalled. Both are one positive recalls family.
    mintObjectPath(pathRepo, 1, MEMORY_1, MEMORY_2);
    mintObjectPath(pathRepo, 2, MEMORY_3, MEMORY_2, {
      constitution: { relation_kind: "co_recalled", why_this_relation_exists: ["x"] }
    });

    expect(repo.listAcceptedAwaitingPath("workspace-1", 32)).toEqual([]);
  });

  it("keeps supports and contradicts proposals awaiting when only unrelated co_recalled paths exist", async () => {
    const { repo, pathRepo } = await createRepo();
    repo.create(createProposalInput("proposal-supports-kind", MEMORY_1, MEMORY_2, "supports"));
    repo.create(createProposalInput("proposal-contradicts-sign", MEMORY_2, MEMORY_3, "contradicts"));
    repo.create(createProposalInput("proposal-supports-direction", MEMORY_1, MEMORY_3, "supports"));
    for (const proposalId of ["proposal-supports-kind", "proposal-contradicts-sign", "proposal-supports-direction"]) {
      repo.updateReview({
        proposalId,
        status: "accepted",
        reviewerIdentity: "user:reviewer",
        reviewReason: "accepted",
        reviewedAt: "2026-05-24T00:05:00.000Z"
      });
    }
    mintObjectPath(pathRepo, 1, MEMORY_1, MEMORY_2, {
      constitution: { relation_kind: "co_recalled", why_this_relation_exists: ["same objects, wrong family"] }
    });
    mintObjectPath(pathRepo, 2, MEMORY_2, MEMORY_3, {
      constitution: { relation_kind: "co_recalled", why_this_relation_exists: ["same objects, wrong sign"] }
    });
    mintObjectPath(pathRepo, 3, MEMORY_3, MEMORY_1, {
      constitution: { relation_kind: "supports", why_this_relation_exists: ["same kind, wrong direction"] }
    });

    expect(repo.listAcceptedAwaitingPath("workspace-1", 32).map((row) => row.proposal_id)).toEqual([
      "proposal-contradicts-sign",
      "proposal-supports-direction",
      "proposal-supports-kind"
    ]);
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

  it("does not starve an orphan behind a proposal satisfied by derived backing anchors", async () => {
    const extraMemoryIds = [objectId(40), objectId(41), objectId(42), objectId(43)];
    const { repo, pathRepo } = await createRepo(extraMemoryIds);
    const healthySource = extraMemoryIds[0];
    const healthyTarget = extraMemoryIds[1];
    const orphanSource = extraMemoryIds[2];
    const orphanTarget = extraMemoryIds[3];

    repo.create(
      createProposalInput("healthy-derived-anchor", healthySource, healthyTarget, "recalls", "2026-05-24T00:00:00.000Z")
    );
    repo.updateReview({
      proposalId: "healthy-derived-anchor",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted and represented by derived path",
      reviewedAt: "2026-05-24T00:01:00.000Z"
    });
    mintObjectPath(pathRepo, 40, healthySource, healthyTarget, {
      anchors: {
        source_anchor: {
          kind: "risk_concern",
          source_object_id: healthySource,
          concern_digest: "credential_leak"
        },
        target_anchor: { kind: "object", object_id: healthyTarget }
      }
    });
    expect((await pathRepo.findByAnchors("workspace-1", [{ kind: "object", object_id: healthySource }])).map(
      (row) => row.path_id
    )).toEqual([]);
    expect((await pathRepo.findByBackingObjectId("workspace-1", healthySource)).map((row) => row.path_id)).toEqual([
      "path-40"
    ]);

    repo.create(createProposalInput("orphan-real", orphanSource, orphanTarget, "recalls", "2026-05-24T01:00:00.000Z"));
    repo.updateReview({
      proposalId: "orphan-real",
      status: "accepted",
      reviewerIdentity: "user:reviewer",
      reviewReason: "accepted then crashed before mint",
      reviewedAt: "2026-05-24T01:00:01.000Z"
    });

    expect(repo.listAcceptedAwaitingPath("workspace-1", 1).map((row) => row.proposal_id)).toEqual(["orphan-real"]);
  });

  // invariant (FIX-2): the await-path path-exists probe must ride the
  // migration 087 backing-object expression indexes, not degrade to a workspace
  // SCAN of path_relations per accepted proposal. A single OR across the
  // source-backing and target-backing expressions defeats the seek; the UNION
  // ALL split lets each orientation seek the backing-object index. EXPLAIN
  // QUERY PLAN runs over the repo's OWN prepared statement so expression drift
  // fails this test.
  it("await-path probe rides the backing-object indexes (SEARCH path_relations, no workspace SCAN)", async () => {
    const { repo, pathRepo, database } = await createRepo();
    // Seed enough path_relations that a scan plan would be the costly path the
    // planner avoids only by riding the expression index.
    mintObjectPath(pathRepo, 1, MEMORY_1, MEMORY_2);
    mintObjectPath(pathRepo, 2, MEMORY_2, MEMORY_3);
    mintObjectPath(pathRepo, 3, MEMORY_1, MEMORY_3);

    const statements = repo.__pathExistsSqlForTest();
    const plans = [
      database.connection
        .prepare(`EXPLAIN QUERY PLAN ${statements.positiveRecalls}`)
        .all("workspace-1", MEMORY_1, MEMORY_2, "workspace-1", MEMORY_2, MEMORY_1),
      database.connection
        .prepare(`EXPLAIN QUERY PLAN ${statements.directional}`)
        .all("workspace-1", MEMORY_1, MEMORY_2, "supports", "positive", "positive", "positive")
    ] as ReadonlyArray<ReadonlyArray<{ readonly detail: string }>>;

    for (const plan of plans) {
      const details = plan.map((step) => step.detail).join(" | ");
      // The subquery SEARCHes path_relations through one backing-object index
      // with the backing id BOUND (an index seek), not a residual filter.
      expect(
        plan.some(
          (step) =>
            step.detail.includes("SEARCH") &&
            step.detail.includes("path_relations") &&
            (step.detail.includes("idx_path_relations_source_backing_object_id") ||
              step.detail.includes("idx_path_relations_target_backing_object_id"))
        ),
        `expected a backing-object index SEARCH of path_relations, got: ${details}`
      ).toBe(true);
      // path_relations is never SCANned (a workspace-scoped scan per proposal is
      // exactly the regression this guard catches).
      expect(
        plan.some((step) => step.detail.startsWith("SCAN") && step.detail.includes("path_relations")),
        `expected no SCAN of path_relations, got: ${details}`
      ).toBe(false);
    }
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
