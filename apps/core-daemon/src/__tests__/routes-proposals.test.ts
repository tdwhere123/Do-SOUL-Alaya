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
});
