import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicsService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { buildProposalReviewKarmaMutation } from "../../mcp-memory/proposal-review-karma.js";
import {
  createMcpMemoryProposalWorkflow,
  type McpMemoryProposalWorkflowDependencies
} from "../../mcp-memory/proposal-workflow.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("buildProposalReviewKarmaMutation", () => {
  it("builds accept_gain mutation for a memory_entry proposal accept", () => {
    const afterCommit = vi.fn();
    const emitKarmaEventInCurrentTransaction = vi.fn(() => ({
      events: [{ event_type: "memory.state_changed" }],
      afterCommit
    }));
    const deps = {
      dynamicsService: { emitKarmaEventInCurrentTransaction }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    const mutation = buildProposalReviewKarmaMutation(
      deps,
      {
        proposal: { derived_from: "memory-target" },
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "memory_entry",
        target_object_id: "memory-target"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "accept",
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        sessionId: "session-1",
        surfaceId: null
      }
    );

    expect(mutation?.applySynchronousResolutionMutation()).toEqual([{ event_type: "memory.state_changed" }]);
    expect(emitKarmaEventInCurrentTransaction).toHaveBeenCalledTimes(1);
    expect(emitKarmaEventInCurrentTransaction).toHaveBeenCalledWith({
      kind: "accept_gain",
      objectId: "memory-target",
      workspaceId: "workspace-1",
      runId: "run-1"
    });
    mutation?.afterCommit();
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it("builds reject_penalty mutation for a memory_entry proposal reject", () => {
    const emitKarmaEventInCurrentTransaction = vi.fn(() => ({
      events: [],
      afterCommit: vi.fn()
    }));
    const deps = {
      dynamicsService: { emitKarmaEventInCurrentTransaction }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    const mutation = buildProposalReviewKarmaMutation(
      deps,
      {
        proposal: { derived_from: "memory-target" },
        workspace_id: "workspace-1",
        run_id: null,
        target_object_kind: "memory_entry",
        target_object_id: "memory-target"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "reject",
      {
        workspaceId: "workspace-1",
        runId: null,
        agentTarget: "codex",
        sessionId: "session-1",
        surfaceId: null
      }
    );

    expect(mutation).toBeDefined();
    mutation?.applySynchronousResolutionMutation();
    expect(emitKarmaEventInCurrentTransaction).toHaveBeenCalledTimes(1);
    expect(emitKarmaEventInCurrentTransaction).toHaveBeenCalledWith({
      kind: "reject_penalty",
      objectId: "memory-target",
      workspaceId: "workspace-1",
      runId: null
    });
  });

  it("skips karma for non-memory_entry proposals", () => {
    const emitKarmaEventInCurrentTransaction = vi.fn();
    const deps = {
      dynamicsService: { emitKarmaEventInCurrentTransaction }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    const mutation = buildProposalReviewKarmaMutation(
      deps,
      {
        proposal: { derived_from: "path-1" },
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "path_relation",
        target_object_id: "path-1"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "accept",
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        sessionId: "session-1",
        surfaceId: null
      }
    );

    expect(mutation).toBeUndefined();
    expect(emitKarmaEventInCurrentTransaction).not.toHaveBeenCalled();
  });

  it("rolls back proposal review and real karma mutation when audit append fails", async () => {
    const database = createDb();
    const proposalRepo = new SqliteProposalRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
    const karmaEventRepo = new SqliteKarmaEventRepo(database);
    const memory = await memoryEntryRepo.create(memoryEntry());
    const dynamics = new DynamicsService({
      memoryRepo: memoryEntryRepo,
      karmaEventRepo,
      eventLogRepo,
      runtimeNotifier: { notifyEntry: () => {} },
      now: () => "2026-05-06T00:00:00.000Z",
      generateEventId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    const workflow = createMcpMemoryProposalWorkflow({
      now: () => "2026-05-06T00:00:00.000Z",
      generateObjectId: () => "99999999-9999-4999-8999-999999999999",
      eventLogRepo,
      proposalRepo,
      runtimeNotifier: { notifyEntry: () => {} },
      reviewerIdentityBinding: { token: "reviewer-token", identity: "user:reviewer" },
      memoryService: memoryServiceFor(memoryEntryRepo),
      dynamicsService: {
        emitKarmaEvent: (input) => dynamics.emitKarmaEvent(input),
        emitKarmaEventInCurrentTransaction: (input) => {
          const mutation = dynamics.emitKarmaEventInCurrentTransaction(input);
          return {
            ...mutation,
            events: [
              ...mutation.events,
              { event_type: "invalid", entity_type: "memory_entry" } as never
            ]
          };
        }
      }
    });

    const created = await workflow.proposeMemoryUpdate(
      {
        target_object_id: memory.object_id,
        proposed_changes: { content: "accepted content" },
        reason: "test proposal"
      },
      { workspaceId: memory.workspace_id, runId: memory.run_id, agentTarget: "codex", sessionId: "session-1" }
    );

    await expect(
      workflow.reviewMemoryProposal(
        {
          proposal_id: created.proposal_id,
          verdict: "accept",
          reviewer_token: "reviewer-token"
        },
        { workspaceId: memory.workspace_id, runId: memory.run_id, agentTarget: "codex", sessionId: "session-1" }
      )
    ).rejects.toThrow();

    await expect(proposalRepo.findById(created.proposal_id)).resolves.toMatchObject({
      resolution_state: "pending"
    });
    await expect(memoryEntryRepo.findById(memory.object_id)).resolves.toMatchObject({
      content: "original content",
      reinforcement_count: 0,
      retention_score: 0.9
    });
    await expect(karmaEventRepo.findByObjectId(memory.object_id)).resolves.toHaveLength(0);
  });
});

function createDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return database;
}

function memoryServiceFor(memoryEntryRepo: SqliteMemoryEntryRepo) {
  return {
    findByIdScoped: async (objectId: string, workspaceId: string) => {
      const live = await memoryEntryRepo.findById(objectId);
      return live?.workspace_id === workspaceId ? live : null;
    },
    validateUpdate: async () => {}
  } as unknown as McpMemoryProposalWorkflowDependencies["memoryService"];
}

function memoryEntry(): MemoryEntry {
  return {
    object_id: "11111111-2222-4222-8222-333333333333",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    created_by: "test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "original content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "ws-karma-rollback",
    run_id: "44444444-5555-4555-8555-666666666666",
    surface_id: null,
    storage_tier: "hot",
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
    superseded_by: null
  };
}
