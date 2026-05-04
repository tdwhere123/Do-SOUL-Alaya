import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryGovernanceEventType,
  ProposalResolutionState,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteProposalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createMcpMemoryProposalWorkflow } from "../mcp-memory-proposal-workflow.js";

// A1 fix-loop (finding-6): the original A1 work tested that the
// workflow *passes* reviewer_identity into the resolution events
// (governance test) and that the proposals row persists it (storage
// test). Neither covered the audit-replay direction:
//
//   create → review → query event_log → reconstruct review record →
//   reviewer_identity intact?
//
// This test composes the workflow against the real SqliteProposalRepo
// + SqliteEventLogRepo, drives a review through the workflow, then
// reads back from event_log via SqliteEventLogRepo.queryByEntity and
// asserts every SOUL_REVIEW_* row's caused_by equals the reviewer
// identity that came in. Includes a non-ASCII / quote-bearing identity
// to lock UTF-8 round-trip through the JSON column boundary.

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("mcp memory proposal workflow — event_log audit replay (A1 finding-6)", () => {
  it("preserves reviewer_identity on every SOUL_REVIEW_* event_log row through real repos", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => "11111111-2222-4222-8222-333333333333",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: "mem-target",
        proposed_changes: { content: "corrected" },
        reason: "operator correction"
      },
      { workspaceId: "ws-replay", runId: "run-1", agentTarget: "codex" }
    );

    const reviewerIdentity = "user:alice";
    const reviewed = await workflow.reviewMemoryProposal(
      {
        proposal_id: created.proposal_id,
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: reviewerIdentity
      },
      { workspaceId: "ws-replay", runId: "run-1", agentTarget: "codex" }
    );
    expect(reviewed.resolution_state).toBe(ProposalResolutionState.ACCEPTED);

    // Read event_log back via the repo (audit replay surface) and
    // assert the caused_by invariant on every SOUL_REVIEW_* row.
    const replayed = await eventLogRepo.queryByEntity("proposal", created.proposal_id);
    const reviewEvents = replayed.filter((entry) =>
      entry.event_type === MemoryGovernanceEventType.SOUL_REVIEW_CREATED ||
      entry.event_type === MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED ||
      entry.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    );
    expect(reviewEvents).toHaveLength(3);
    for (const event of reviewEvents) {
      expect(event.caused_by).toBe(reviewerIdentity);
    }

    // Sanity: the propose path keeps caused_by = agentTarget so the
    // audit trail still names who created the proposal.
    const createdEvent = replayed.find(
      (entry) => entry.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED
    );
    expect(createdEvent).toBeDefined();
    expect(createdEvent?.caused_by).toBe("codex");
  });

  it("round-trips a non-ASCII reviewer identity with embedded quotes through event_log (UTF-8 lock)", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-04-30T00:00:00.000Z",
      generateObjectId: () => "44444444-5555-4555-8555-666666666666",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: async () => {} }
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: "mem-utf8",
        proposed_changes: { content: "fix encoding" },
        reason: "utf-8 audit"
      },
      { workspaceId: "ws-utf8", runId: "run-utf8", agentTarget: "codex" }
    );

    // Mix of CJK + Latin extended + an internal quote. better-sqlite3
    // binds parameters, so the quote is not an injection vector — it's
    // a UTF-8 / quoting-discipline guard, mirroring the kind of names
    // that appear in shared agent fleets ("Mei \"the proxy\" Lin",
    // 中文运维, etc.).
    const reviewerIdentity = "审核者:Mei \"the proxy\" Lin";
    await workflow.reviewMemoryProposal(
      {
        proposal_id: created.proposal_id,
        verdict: "reject",
        reason: "utf-8 reviewer",
        reviewer_identity: reviewerIdentity
      },
      // Human-reviewer surface (runId: null) — also exercises the
      // finding-1 loosened context check on a real repo.
      { workspaceId: "ws-utf8", runId: null, agentTarget: "inspector" }
    );

    const replayed = await eventLogRepo.queryByEntity("proposal", created.proposal_id);
    const reviewEvents = replayed.filter((entry) =>
      entry.event_type === MemoryGovernanceEventType.SOUL_REVIEW_CREATED ||
      entry.event_type === MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED ||
      entry.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED
    );
    expect(reviewEvents).toHaveLength(3);
    for (const event of reviewEvents) {
      expect(event.caused_by).toBe(reviewerIdentity);
    }

    // Spot-check the proposals row stored the same identity verbatim.
    const scoped = await proposalRepo.findScopedById(created.proposal_id);
    expect(scoped?.reviewer_identity).toBe(reviewerIdentity);
  });
});

function createDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return database;
}

// Suppress unused-import lints when the EventLogEntry / Proposal types
// are required only for type-only checks elsewhere in the file.
type _UsedTypes = readonly [EventLogEntry, Proposal];
