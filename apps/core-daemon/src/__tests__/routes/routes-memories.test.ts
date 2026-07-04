import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryRoutes } from "../../routes/memories.js";
import { memoryRouteServices } from "../support/route-service-stubs.js";

type MemoryRouteFixture = {
  readonly object_id: string;
  readonly dimension?: string;
  readonly scope_class?: string;
  readonly contradiction_count?: number;
};

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
      findByWorkspaceId: vi.fn(async (): Promise<MemoryRouteFixture[]> => [{ object_id: "m1" }, { object_id: "m2" }, { object_id: "m3" }]),
      countByWorkspaceId: vi.fn(async () => 3),
      findByDimension: vi.fn(async () => [{ object_id: "m2" }]),
      countByDimension: vi.fn(async () => 1),
      findByScopeClass: vi.fn(async (): Promise<MemoryRouteFixture[]> => []),
      findByScopeClassWithConflict: vi.fn(async (): Promise<MemoryRouteFixture[]> => [
        { object_id: "m-project-conflict-1", dimension: "fact", scope_class: "project", contradiction_count: 2 },
        { object_id: "m-project-conflict-2", dimension: "fact", scope_class: "project", contradiction_count: 1 }
      ]),
      countByScopeClassWithConflict: vi.fn(async () => 2),
      findByWorkspaceIdWithConflict: vi.fn(async (): Promise<MemoryRouteFixture[]> => []),
      countByWorkspaceIdWithConflict: vi.fn(async () => 0),
      findByDimensionWithConflict: vi.fn(async (): Promise<MemoryRouteFixture[]> => []),
      countByDimensionWithConflict: vi.fn(async () => 0),
      findByScopeClassAndDimensionWithConflict: vi.fn(async (): Promise<MemoryRouteFixture[]> => []),
      countByScopeClassAndDimensionWithConflict: vi.fn(async () => 0),
      findByRunId: vi.fn(async () => [{ object_id: "m3" }]),
      countByRunId: vi.fn(async () => 1),
      findById: vi.fn(async () => {
        throw new Error("findById must not be reachable from HTTP /memories/:id");
      })
    };
    registerMemoryRoutes(app, memoryRouteServices({ workspaceService, runService, memoryService }));
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
    expect(memoryService.findByWorkspaceId).toHaveBeenCalledWith("ws-1", {
      limit: 200,
      offset: 0
    });
    expect(memoryService.countByWorkspaceId).toHaveBeenCalledWith("ws-1");
  });

  it("passes pagination to GET /workspaces/:wsId/memories without handler-level slicing", async () => {
    const { app, memoryService } = buildApp();
    memoryService.findByWorkspaceId.mockImplementation(async (...args: unknown[]) => {
      const page = args[1];
      expect(page).toEqual({ limit: 1, offset: 1 });
      return [{ object_id: "m2" }];
    });

    const response = await app.request("/workspaces/ws-1/memories?limit=1&offset=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("3");
    expect(response.headers.get("x-limit")).toBe("1");
    expect(response.headers.get("x-offset")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ object_id: "m2" }]
    });
    expect(memoryService.countByWorkspaceId).toHaveBeenCalledWith("ws-1");
  });

  it("uses SQL-backed conflict filtering for has_conflict workspace memory lists", async () => {
    const { app, memoryService } = buildApp();
    memoryService.findByScopeClassWithConflict.mockImplementation(async (...args: unknown[]) => {
      expect(args).toEqual(["ws-1", "project", { limit: 1, offset: 1 }]);
      return [{ object_id: "m-project-conflict-2", dimension: "fact", scope_class: "project", contradiction_count: 1 }];
    });

    const response = await app.request(
      "/workspaces/ws-1/memories?scope_class=project&has_conflict=true&limit=1&offset=1"
    );

    expect(response.status).toBe(200);
    expect(memoryService.findByScopeClassWithConflict).toHaveBeenCalledWith("ws-1", "project", {
      limit: 1,
      offset: 1
    });
    expect(memoryService.countByScopeClassWithConflict).toHaveBeenCalledWith("ws-1", "project");
    expect(memoryService.findByScopeClass).not.toHaveBeenCalled();
    expect(memoryService.findByWorkspaceId).not.toHaveBeenCalled();
    expect(response.headers.get("x-total-count")).toBe("2");
    expect(response.headers.get("x-limit")).toBe("1");
    expect(response.headers.get("x-offset")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ object_id: "m-project-conflict-2", dimension: "fact", scope_class: "project", contradiction_count: 1 }]
    });
  });

  it("retains GET /runs/:runId/memories with run scoping", async () => {
    const { app, runService, memoryService } = buildApp();

    const response = await app.request("/runs/run-1/memories");

    expect(response.status).toBe(200);
    expect(runService.getById).toHaveBeenCalledWith("run-1");
    expect(memoryService.findByRunId).toHaveBeenCalledWith("run-1", {
      limit: 200,
      offset: 0
    });
    expect(memoryService.countByRunId).toHaveBeenCalledWith("run-1");
  });
});
