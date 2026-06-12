import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryRoutes } from "../../routes/memories.js";

// HTTP GET /memories/:id is intentionally absent because it previously
// bypassed workspace scoping. This test pins the removal so a future
// re-introduction must explicitly update the assertion.
describe("memory routes (HTTP surface narrowed)", () => {
  function buildApp() {
    const app = new Hono();
    const workspaceService = {
      getById: vi.fn(async () => ({ workspace_id: "ws-1" }))
    };
    const runService = {
      getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" }))
    };
    const memoryService = {
      findByWorkspaceId: vi.fn(async () => [{ object_id: "m1" }]),
      findByDimension: vi.fn(async () => [{ object_id: "m2" }]),
      findByRunId: vi.fn(async () => [{ object_id: "m3" }]),
      findById: vi.fn(async () => {
        throw new Error("findById must not be reachable from HTTP /memories/:id");
      })
    };
    registerMemoryRoutes(app, { workspaceService, runService, memoryService } as any);
    return { app, workspaceService, runService, memoryService };
  }

  it("removes GET /memories/:id (MR-B02: route-layer cross-workspace leak)", async () => {
    const { app, memoryService } = buildApp();

    const response = await app.request("/memories/m1");

    expect(response.status).toBe(404);
    expect(memoryService.findById).not.toHaveBeenCalled();
  });

  it("retains GET /workspaces/:wsId/memories with workspace scoping", async () => {
    const { app, workspaceService, memoryService } = buildApp();

    const response = await app.request("/workspaces/ws-1/memories");

    expect(response.status).toBe(200);
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(memoryService.findByWorkspaceId).toHaveBeenCalledWith("ws-1");
  });

  it("retains GET /runs/:runId/memories with run scoping", async () => {
    const { app, runService, memoryService } = buildApp();

    const response = await app.request("/runs/run-1/memories");

    expect(response.status).toBe(200);
    expect(runService.getById).toHaveBeenCalledWith("run-1");
    expect(memoryService.findByRunId).toHaveBeenCalledWith("run-1");
  });
});
