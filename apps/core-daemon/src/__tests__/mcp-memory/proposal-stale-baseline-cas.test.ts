import { afterEach, describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  RetentionPolicy,
  type EventLogEntry,
  type MemoryEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

// Cross-proposal lost-update guard. The accept-and-apply transaction
// CAS-checks the memory entry's updated_at against a baseline captured
// by prepareAcceptedProposalApply. When two proposals target the same
// memory entry, the second accept must either re-capture the baseline
// or refuse to apply against a stale snapshot. This test exercises the
// refuse path directly by feeding the workflow a memoryService stub
// that returns a baseline updated_at that does NOT match the live row.

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return database;
}

async function seedMemoryEntry(
  memoryEntryRepo: SqliteMemoryEntryRepo,
  overrides: Partial<MemoryEntry> = {}
): Promise<MemoryEntry> {
  const base = {
    object_id: "11111111-2222-4222-8222-333333333333",
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    dimension: "preference" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content: "V0",
    domain_tags: [] as readonly string[],
    evidence_refs: [] as readonly string[],
    workspace_id: "ws-cas-1",
    run_id: "44444444-5555-4555-8555-666666666666",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt" as const,
    retention_state: "working" as const,
    decay_profile: "stable" as const,
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
  return await memoryEntryRepo.create(base as MemoryEntry);
}

describe("proposal accept-and-apply cross-proposal CAS predicate", () => {
  it("pins CAS to the proposal creation baseline, not the review-time read", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
    const proposalIds = [
      "aaaaaaaa-bbbb-4bbb-8bbb-cccccccccccc",
      "dddddddd-eeee-4eee-8eee-ffffffffffff"
    ];

    const memory = await seedMemoryEntry(memoryEntryRepo, {
      workspace_id: "ws-cas-create"
    });
    const memoryService = {
      findByIdScoped: async (objectId: string, workspaceId: string) => {
        const live = await memoryEntryRepo.findById(objectId);
        return live?.workspace_id === workspaceId ? live : null;
      },
      validateUpdate: async () => {},
      update: async (objectId: string) => ({ object_id: objectId })
    };
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-06T00:00:00.000Z",
      generateObjectId: () => proposalIds.shift() ?? "ffffffff-ffff-4fff-8fff-ffffffffffff",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: async () => {} },
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:reviewer" },
      memoryService
    });

    const first = await workflow.proposeMemoryUpdate(
      {
        target_object_id: memory.object_id,
        proposed_changes: { content: "V1" },
        reason: "first proposal"
      },
      { workspaceId: "ws-cas-create", runId: null, agentTarget: "codex", sessionId: "session-1" }
    );
    const second = await workflow.proposeMemoryUpdate(
      {
        target_object_id: memory.object_id,
        proposed_changes: { content: "V2 stale" },
        reason: "second proposal against V0"
      },
      { workspaceId: "ws-cas-create", runId: null, agentTarget: "codex", sessionId: "session-1" }
    );

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: first.proposal_id,
          verdict: "accept",
          reason: "accept first",
          reviewer_identity: "user:reviewer",
          reviewer_token: "reviewer-token"
        },
        { workspaceId: "ws-cas-create", runId: null, agentTarget: "inspector", sessionId: "session-1" }
      )
    ).resolves.toMatchObject({ resolution_state: ProposalResolutionState.ACCEPTED });

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: second.proposal_id,
          verdict: "accept",
          reason: "accept second after target changed",
          reviewer_identity: "user:reviewer",
          reviewer_token: "reviewer-token"
        },
        { workspaceId: "ws-cas-create", runId: null, agentTarget: "inspector", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("stale snapshot")
    });

    const live = await memoryEntryRepo.findById(memory.object_id);
    expect(live?.content).toBe("V1");
    expect((await proposalRepo.findScopedById(second.proposal_id))?.proposal.resolution_state).toBe(
      ProposalResolutionState.PENDING
    );
  });

  it("refuses to apply when the memory's live updated_at moved past the captured baseline", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);

    const memory = await seedMemoryEntry(memoryEntryRepo);
    expect(memory.updated_at).toBe("2026-04-30T00:00:00.000Z");

    // Stub memoryService returns a baseline that intentionally does
    // NOT match the live row's updated_at. In production, this is the
    // exact symptom seen when a sibling proposal accept committed
    // between this workflow's pre-validation read and its storage tx.
    const staleBaselineMemoryService = {
      findByIdScoped: async (objectId: string, _workspaceId: string) => ({
        object_id: objectId,
        updated_at: "1999-01-01T00:00:00.000Z"
      }),
      validateUpdate: async () => {},
      update: async (objectId: string) => ({ object_id: objectId })
    };

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-06T00:00:00.000Z",
      generateObjectId: () => "aaaaaaaa-bbbb-4bbb-8bbb-cccccccccccc",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: async () => {} },
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:reviewer" },
      memoryService: staleBaselineMemoryService
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: memory.object_id,
        proposed_changes: { content: "V1-from-stale-proposal" },
        reason: "stale-baseline test"
      },
      { workspaceId: "ws-cas-1", runId: "run-cas-1", agentTarget: "codex", sessionId: "session-1" }
    );

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: created.proposal_id,
          verdict: "accept",
          reason: "approved despite stale baseline",
          reviewer_identity: "user:reviewer",
          reviewer_token: "reviewer-token"
        },
        { workspaceId: "ws-cas-1", runId: null, agentTarget: "inspector", sessionId: "session-1" }
      )
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("stale snapshot")
    });

    // Memory is unchanged — no V1-from-stale-proposal write committed.
    const live = await memoryEntryRepo.findById(memory.object_id);
    expect(live?.content).toBe("V0");
    expect(live?.updated_at).toBe("2026-04-30T00:00:00.000Z");

    // Proposal stays pending — reviewer can re-review against the
    // current baseline.
    const scoped = await proposalRepo.findScopedById(created.proposal_id);
    expect(scoped?.proposal.resolution_state).toBe(ProposalResolutionState.PENDING);

    // No SOUL_MEMORY_UPDATED event from this proposal landed in audit.
    const memoryEvents = await eventLogRepo.queryByEntity("memory_entry", memory.object_id);
    const updateEvents = memoryEvents.filter(
      (event) => event.event_type === MemoryGovernanceEventType.SOUL_MEMORY_UPDATED
    );
    expect(updateEvents).toHaveLength(0);
  });

  it("applies cleanly when baseline matches (regression coverage for the happy path)", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);

    const memory = await seedMemoryEntry(memoryEntryRepo, {
      object_id: "77777777-8888-4888-8888-999999999999",
      workspace_id: "ws-cas-2",
      updated_at: "2026-04-30T00:00:00.000Z"
    });

    const matchingBaselineMemoryService = {
      findByIdScoped: async (objectId: string, _workspaceId: string) => ({
        object_id: objectId,
        updated_at: memory.updated_at
      }),
      validateUpdate: async () => {},
      update: async (objectId: string) => ({ object_id: objectId })
    };

    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-06T00:00:00.000Z",
      generateObjectId: () => "dddddddd-eeee-4eee-8eee-ffffffffffff",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: async () => {} },
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:reviewer" },
      memoryService: matchingBaselineMemoryService
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: memory.object_id,
        proposed_changes: { content: "V1" },
        reason: "matching baseline test"
      },
      { workspaceId: "ws-cas-2", runId: "run-cas-2", agentTarget: "codex", sessionId: "session-1" }
    );

    const review = await workflow.reviewMemoryProposal(
      {
        proposal_id: created.proposal_id,
        verdict: "accept",
        reason: "approved against matching baseline",
        reviewer_identity: "user:reviewer",
        reviewer_token: "reviewer-token"
      },
      { workspaceId: "ws-cas-2", runId: null, agentTarget: "inspector", sessionId: "session-1" }
    );

    expect(review.resolution_state).toBe(ProposalResolutionState.ACCEPTED);

    const live = await memoryEntryRepo.findById(memory.object_id);
    expect(live?.content).toBe("V1");
  });
});

// Suppress unused-import lints; the type-only references hold so the
// fixture types stay anchored to the protocol definitions.
type _UsedTypes = readonly [
  EventLogEntry,
  Proposal,
  typeof ControlPlaneObjectKind,
  typeof ProposalOptionKind,
  typeof RetentionPolicy
];
