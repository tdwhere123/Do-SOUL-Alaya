import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerProposalRoutes } from "../routes/proposals.js";

// p5-system-review-r1: HTTP review/read-by-id routes were removed; v0.1.0 release
// surface is MCP + CLI only. These tests pin the removal so a future re-introduction
// must explicitly update the assertions.
describe("proposal routes (HTTP surface narrowed in p5-system-review-r1)", () => {
  function buildApp() {
    const app = new Hono();
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const proposalService = {
      findByWorkspaceId: vi.fn(async () => []),
      findPending: vi.fn(async () => []),
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
    expect(proposalService.findPending).toHaveBeenCalledWith("ws-1");
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
        agentTarget: "inspector"
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

  it("still creates a new proposal when the existing pending proposal has different proposed_changes", async () => {
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
      output: { proposal_id: "new-rewrite-proposal", status: "created" }
    }));
    const listPending = vi.fn(async () => ({
      ok: true as const,
      output: {
        proposals: [
          {
            proposal_id: "existing-keep-proposal",
            target_object_id: "mem-1",
            target_object_kind: "memory_entry",
            created_at: "2026-05-09T00:00:00.000Z",
            proposed_change_summary: "keep mem-1",
            // Different shape than retire — dedupe must NOT match.
            proposed_changes: { confidence: 0.65 },
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
      data: { proposal_id: "new-rewrite-proposal", status: "created" }
    });
    expect(propose).toHaveBeenCalled();
  });
});
