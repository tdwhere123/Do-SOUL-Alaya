import { Hono } from "hono";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  ScopeClass,
  SoulProposalCreatedPayloadSchema,
  SourceKind,
  StorageTier,
  MemoryGovernanceEventType,
  RuntimeGovernanceEventType,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteCoUsageCounterRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteProposalRepo,
  SqliteWorkspaceRepo,
  type PathRelationProposalPayload,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { EventPublisher, PathRelationProposalService } from "@do-soul/alaya-core";

import { createMcpMemoryProposalWorkflow } from "../../mcp-memory/proposal-workflow.js";

import { registerProposalRoutes } from "../../routes/proposals.js";

const databases = new Set<StorageDatabase>();

function createMemoryEntry(objectId: string, workspaceId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "routes-proposals-test",
    dimension: MemoryDimension.CONSTRAINT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Do not bypass review.",
    domain_tags: ["governance"],
    evidence_refs: [],
    workspace_id: workspaceId,
    run_id: "run-routes-proposals",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.8,
    retention_score: 1,
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

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("proposal routes (HTTP surface narrowed)", () => {

  function buildApp() {
    const app = new Hono();
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => [{ proposal_id: "p1" }, { proposal_id: "p2" }, { proposal_id: "p3" }]),
      countByWorkspaceId: vi.fn(async () => 3),
      findPending: vi.fn(async () => [{ proposal_id: "p1" }, { proposal_id: "p2" }, { proposal_id: "p3" }]),
      countPending: vi.fn(async () => 3),
      findById: vi.fn(async () => ({ proposal_id: "p1" })),
      review: vi.fn(async () => {
        throw new Error("review must not be reachable from HTTP");
      })
    };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1", confidence: 0.6 }))
    };
    const mcpMemoryToolHandler = {
      call: vi.fn(async () => ({
        ok: true,
        output: { proposal_id: "proposal-1", status: "created" }
      }))
    };
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    } as any);
    return { app, workspaceService, proposalService, memoryService, mcpMemoryToolHandler };
  }

  it("removes POST /proposals/:id/review (MR-B01: non-atomic + no workspace scoping)", async () => {
    const { app, proposalService } = buildApp();

    const response = await app.request("/proposals/p1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accepted" })
    });

    expect(response.status).toBe(404);
    expect(proposalService.review).not.toHaveBeenCalled();
  });

  it("removes GET /proposals/:id (MR-B02 sibling: no workspace scoping at route layer)", async () => {
    const { app, proposalService } = buildApp();

    const response = await app.request("/proposals/p1");

    expect(response.status).toBe(404);
    expect(proposalService.findById).not.toHaveBeenCalled();
  });

  it("retains GET /workspaces/:wsId/proposals with workspace scoping", async () => {
    const { app, workspaceService, proposalService } = buildApp();

    const response = await app.request("/workspaces/ws-1/proposals");

    expect(response.status).toBe(200);
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(proposalService.findPending).toHaveBeenCalledWith("ws-1", {
      limit: 200,
      offset: 0
    });
    expect(proposalService.countPending).toHaveBeenCalledWith("ws-1");
  });

  it("passes pagination to GET /workspaces/:wsId/proposals without handler-level slicing", async () => {
    const { app, proposalService } = buildApp();
    proposalService.findPending.mockImplementation(async (...args: unknown[]) => {
      const page = args[1];
      expect(page).toEqual({ limit: 2, offset: 1 });
      return [{ proposal_id: "p2" }, { proposal_id: "p3" }];
    });

    const response = await app.request("/workspaces/ws-1/proposals?limit=2&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    expect(response.headers.get("x-limit")).toBe("2");
    expect(response.headers.get("x-offset")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ proposal_id: "p2" }, { proposal_id: "p3" }]
    });
  });

  it("creates Inspector memory-action proposals through the MCP proposal workflow", async () => {
    const { app, mcpMemoryToolHandler, memoryService } = buildApp();

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/downgrade", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { proposal_id: "proposal-1", status: "created" }
    });
    expect(memoryService.findByIdScoped).toHaveBeenCalledWith("mem-1", "ws-1");
    expect(mcpMemoryToolHandler.call).toHaveBeenCalledWith({
      toolName: "soul.propose_memory_update",
      arguments: {
        target_object_id: "mem-1",
        proposed_changes: { confidence: 0.4 },
        reason: "Downgrade memory mem-1: Inspector user requested weaker trust."
      },
      context: {
        workspaceId: "ws-1",
        runId: null,
        agentTarget: "inspector",
        sessionId: expect.stringMatching(/^inspector-/)
      }
    });
  });

  it("encodes retire as a tombstone proposal and never mutates the memory route-side", async () => {
    const { app, mcpMemoryToolHandler } = buildApp();

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/retire", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(mcpMemoryToolHandler.call).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.propose_memory_update",
        arguments: expect.objectContaining({
          proposed_changes: {
            retention_state: "tombstoned",
            storage_tier: "cold"
          }
        })
      })
    );
  });

  // M-1 (Phase 2 review-loop): a second click of the same Inspector action
  // button on the same memory must not spam-create duplicate pending
  // proposals. The route should detect an existing pending proposal whose
  // target + proposed_changes match and return its proposal_id with
  // status=already_pending instead of creating another one.
  it("dedupes a repeated retire click against an existing pending tombstone proposal", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1", confidence: 0.6 }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const propose = vi.fn(async () => ({
      ok: true as const,
      output: { proposal_id: "fresh-proposal", status: "created" }
    }));
    const listPending = vi.fn(async () => ({
      ok: true as const,
      output: {
        proposals: [
          {
            proposal_id: "existing-tombstone-proposal",
            target_object_id: "mem-1",
            target_object_kind: "memory_entry",
            created_at: "2026-05-09T00:00:00.000Z",
            proposed_change_summary: "retire mem-1",
            proposed_changes: { retention_state: "tombstoned", storage_tier: "cold" },
            assigned_reviewer_identity: null,
            assigned_at: null,
            deadline_at: null,
            is_overdue: false
          }
        ]
      }
    }));
    const mcpMemoryToolHandler = {
      call: vi.fn(async (input: { toolName: string }) =>
        input.toolName === "soul.list_pending_proposals" ? await listPending() : await propose()
      )
    };
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      mcpMemoryToolHandler
    } as any);

    const response = await app.request("/workspaces/ws-1/soul/memory/mem-1/proposals/retire", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { proposal_id: "existing-tombstone-proposal", status: "already_pending" }
    });
    // The propose_memory_update path must NOT be invoked when a duplicate is detected.
    expect(propose).not.toHaveBeenCalled();
  });

  // invariant: governance promotion to strictly_governed is auditable and
  // must travel through the Proposal lifecycle, not a direct mutation.
  it("creates a typed path_relation Proposal when promote-strictly-governed is invoked", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const memoryService = {
      findByIdScoped: vi.fn(async () => ({ object_id: "mem-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => [])
    };
    const mcpMemoryToolHandler = { call: vi.fn() };
    const createProposalWithEvents = vi.fn(async (input: { proposal: { proposal_id: string } }) => ({
      proposal: input.proposal,
      events: [{ event_id: "evt-1" }]
    }));
    const notifyEntry = vi.fn();
    registerProposalRoutes(app, {
      workspaceService,
      memoryService,
      proposalService,
      proposalRepo: { createProposalWithEvents },
      runtimeNotifier: { notifyEntry },
      mcpMemoryToolHandler
    } as any);

    const response = await app.request(
      "/workspaces/ws-1/soul/memory/mem-1/proposals/promote-strictly-governed",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        status: string;
        target_object_kind: string;
        requested_governance_class: string;
        target_object_id: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("created");
    expect(body.data.target_object_kind).toBe("path_relation");
    expect(body.data.requested_governance_class).toBe("strictly_governed");
    expect(body.data.target_object_id).toBe("mem-1");

    expect(createProposalWithEvents).toHaveBeenCalledTimes(1);
    const callInput = createProposalWithEvents.mock.calls[0][0] as unknown as {
      target_object_kind: string;
      proposed_change_summary: string;
      proposal: { derived_from: string; resolution_state: string };
    };
    expect(callInput.target_object_kind).toBe("path_relation");
    expect(callInput.proposal.derived_from).toBe("mem-1");
    expect(callInput.proposal.resolution_state).toBe("pending");
    expect(callInput.proposed_change_summary).toContain("strictly_governed");
    // The MCP propose path must NOT be used; the path_relation Proposal
    // does not match SoulProposeMemoryUpdateRequestSchema's
    // PublicMemoryEntryMutableFields constraint.
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });
});
