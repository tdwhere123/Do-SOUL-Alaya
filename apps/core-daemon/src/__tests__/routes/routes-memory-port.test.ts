import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AcceptedBy } from "@do-soul/alaya-protocol";
import { registerMemoryRoutes } from "../../routes/memory/memories.js";
import { registerRecallRoutes } from "../../routes/memory/recall.js";
import { registerEvidenceRoutes } from "../../routes/memory/evidence.js";
import { registerClaimRoutes } from "../../routes/governance/claims.js";
import { registerSynthesisRoutes } from "../../routes/memory/syntheses.js";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import { registerProposalRoutes } from "../../routes/governance/proposals.js";
import { registerGlobalMemoryRoutes } from "../../routes/memory/global-memory.js";
import { registerSignalRoutes } from "../../routes/workspace/signals.js";
import {
  claimRouteServices,
  evidenceRouteServices,
  globalMemoryRouteServices,
  memoryRouteServices,
  proposalRouteServices,
  recallRouteServices,
  signalRouteServices,
  synthesisRouteServices
} from "../support/route-service-stubs.js";

describe("routes-memory port batch", () => {
  it("registerMemoryRoutes lists workspace memories via typed service bag", async () => {
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const runService = { getById: vi.fn(async () => ({ run_id: "run-1" })) };
    const memoryService = {
      findByWorkspaceId: vi.fn(async () => [{ object_id: "m1" }]),
      findByDimension: vi.fn(async () => [{ object_id: "m2" }]),
      countByWorkspaceId: vi.fn(async () => 1),
      countByDimension: vi.fn(async () => 1),
      findByRunId: vi.fn(async () => [{ object_id: "m3" }]),
      countByRunId: vi.fn(async () => 1),
      findById: vi.fn(async () => ({ object_id: "m4" }))
    };

    const app = new Hono();
    registerMemoryRoutes(app, memoryRouteServices({ workspaceService, runService, memoryService }));

    const response = await app.request("/workspaces/ws-1/memories?dimension=fact");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ object_id: "m2" }]
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(memoryService.findByDimension).toHaveBeenCalledWith("ws-1", "fact", {
      limit: 200,
      offset: 0
    });
    expect(memoryService.countByDimension).toHaveBeenCalledWith("ws-1", "fact");
  });

  it("registerRecallRoutes builds task surface and recalls with strategy override", async () => {
    const run = {
      run_id: "run-1",
      workspace_id: "ws-1",
      current_surface_id: "surface-1",
      title: "Recall run"
    };
    const runService = { getById: vi.fn(async () => run) };
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const taskSurface = { surface_kind: "general-chat", object_id: "surface-1" };
    const taskSurfaceBuilder = {
      build: vi.fn(async () => taskSurface),
      resolveStrategy: vi.fn(() => "chat")
    };
    const recallService = {
      recall: vi.fn(async () => ({ candidates: [{ object_id: "memory-1" }] }))
    };

    const app = new Hono();
    registerRecallRoutes(
      app,
      recallRouteServices({
        recallService,
        taskSurfaceBuilder,
        runService,
        workspaceService
      })
    );

    const response = await app.request("/runs/run-1/recall-candidates?strategy=build");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { candidates: [{ object_id: "memory-1" }] }
    });
    expect(taskSurfaceBuilder.build).toHaveBeenCalledTimes(1);
    expect(recallService.recall).toHaveBeenCalledWith({
      taskSurface,
      workspaceId: "ws-1",
      runId: "run-1",
      strategy: "build"
    });
  });

  it("registerEvidenceRoutes resolves evidence through the workspace-scoped pointer path", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const runService = { getById: vi.fn(async () => ({ run_id: "run-1" })) };
    const evidenceService = {
      findByWorkspaceId: vi.fn(),
      findByRunId: vi.fn(),
      findByIdScoped: vi.fn(async () => ({ object_id: "e1", workspace_id: "ws-1" }))
    };
    registerEvidenceRoutes(app, evidenceRouteServices({ workspaceService, runService, evidenceService }));

    const response = await app.request("/workspaces/ws-1/evidence/e1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "e1", workspace_id: "ws-1" }
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(evidenceService.findByIdScoped).toHaveBeenCalledWith("e1", "ws-1");
  });

  it("registerEvidenceRoutes does not expose unscoped evidence by id", async () => {
    const app = new Hono();
    const evidenceService = {
      findByWorkspaceId: vi.fn(),
      findByRunId: vi.fn(),
      findById: vi.fn()
    };
    registerEvidenceRoutes(
      app,
      evidenceRouteServices({
        evidenceService
      })
    );

    const response = await app.request("/evidence/e1");
    expect(response.status).toBe(404);
    expect(evidenceService.findById).not.toHaveBeenCalled();
  });

  it("registerClaimRoutes resolves claims by workspace-scoped id", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const claimService = {
      findByWorkspaceId: vi.fn(),
      findByIdScoped: vi.fn(async () => ({ object_id: "c1", workspace_id: "ws-1" }))
    };
    registerClaimRoutes(app, claimRouteServices({ workspaceService, claimService }));

    const response = await app.request("/workspaces/ws-1/claims/c1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "c1", workspace_id: "ws-1" }
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(claimService.findByIdScoped).toHaveBeenCalledWith("c1", "ws-1");
  });

  it("registerClaimRoutes returns 404 for a claim bound to a foreign workspace", async () => {
    const app = new Hono();
    registerErrorHandler(app, { error: vi.fn() });
    const claimService = {
      findByWorkspaceId: vi.fn(),
      findByIdScoped: vi.fn(async () => null)
    };
    registerClaimRoutes(
      app,
      claimRouteServices({
        workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-b" })) },
        claimService
      })
    );

    const response = await app.request("/workspaces/ws-b/claims/c1");
    expect(response.status).toBe(404);
    expect(claimService.findByIdScoped).toHaveBeenCalledWith("c1", "ws-b");
  });

  it("registerSynthesisRoutes resolves syntheses by workspace-scoped id", async () => {
    const app = new Hono();
    const synthesisService = {
      findByWorkspaceId: vi.fn(),
      findByIdScoped: vi.fn(async () => ({ object_id: "s1", workspace_id: "ws-1" }))
    };
    registerSynthesisRoutes(
      app,
      synthesisRouteServices({
        workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
        synthesisService
      })
    );

    const response = await app.request("/workspaces/ws-1/syntheses/s1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "s1", workspace_id: "ws-1" }
    });
    expect(synthesisService.findByIdScoped).toHaveBeenCalledWith("s1", "ws-1");
  });

  it("registerSynthesisRoutes returns 404 for a capsule bound to a foreign workspace", async () => {
    const app = new Hono();
    registerErrorHandler(app, { error: vi.fn() });
    const synthesisService = {
      findByWorkspaceId: vi.fn(),
      findByIdScoped: vi.fn(async () => null)
    };
    registerSynthesisRoutes(
      app,
      synthesisRouteServices({
        workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-b" })) },
        synthesisService
      })
    );

    const response = await app.request("/workspaces/ws-b/syntheses/s1");
    expect(response.status).toBe(404);
    expect(synthesisService.findByIdScoped).toHaveBeenCalledWith("s1", "ws-b");
  });

  it("registerProposalRoutes does not expose POST /proposals/:id/review", async () => {
    const app = new Hono();
    const review = vi.fn(async () => {
      throw new Error("review must not be reachable from HTTP");
    });
    registerProposalRoutes(
      app,
      proposalRouteServices({
        proposalService: {
          findByWorkspaceId: vi.fn(),
          findPending: vi.fn(),
          countByWorkspaceId: vi.fn(),
          countPending: vi.fn(),
          findById: vi.fn()
        }
      })
    );

    const response = await app.request("/proposals/p1/review", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reviewer-id": "reviewer-1"
      },
      body: JSON.stringify({
        action: "accepted",
        note: "ship it"
      })
    });

    expect(response.status).toBe(404);
    expect(review).not.toHaveBeenCalled();
  });

  it("registerGlobalMemoryRoutes parses filters and applies default accepted_by", async () => {
    const app = new Hono();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const globalMemoryService = {
      list: vi.fn(async () => [{ object_id: "global-1" }]),
      adopt: vi.fn(async () => ({ object_id: "anchor-1" }))
    };
    registerGlobalMemoryRoutes(app, globalMemoryRouteServices({ workspaceService, globalMemoryService }));

    const listResponse = await app.request("/soul/global-memory-entries?dimension=fact&scope_class=project&limit=5");
    expect(listResponse.status).toBe(200);
    expect(globalMemoryService.list).toHaveBeenCalledWith({
      dimension: "fact",
      scope_class: "project",
      limit: 5
    });

    const adoptResponse = await app.request("/soul/global-memory-entries/global-1/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "ws-1"
      })
    });
    expect(adoptResponse.status).toBe(200);
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(globalMemoryService.adopt).toHaveBeenCalledWith("global-1", {
      workspace_id: "ws-1",
      accepted_by: AcceptedBy.USER
    });
  });

  it("registerSignalRoutes lists run signals through signal service", async () => {
    const app = new Hono();
    const runService = { getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" })) };
    const signalService = {
      listByRun: vi.fn(async () => [{ signal_id: "sig-1" }]),
      countByRun: vi.fn(async () => 1),
      receiveSignal: vi.fn()
    };
    registerSignalRoutes(app, signalRouteServices({ runService, signalService }));

    const response = await app.request("/runs/run-1/signals");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ signal_id: "sig-1" }]
    });
    expect(runService.getById).toHaveBeenCalledWith("run-1");
    expect(signalService.listByRun).toHaveBeenCalledWith("run-1", {
      limit: 200,
      offset: 0
    });
    expect(signalService.countByRun).toHaveBeenCalledWith("run-1");
  });
});
