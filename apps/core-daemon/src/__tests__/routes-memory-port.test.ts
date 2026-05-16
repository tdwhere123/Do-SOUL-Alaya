import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AcceptedBy } from "@do-soul/alaya-protocol";
import { registerMemoryRoutes } from "../routes/memories.js";
import { registerRecallRoutes } from "../routes/recall.js";
import { registerEvidenceRoutes } from "../routes/evidence.js";
import { registerClaimRoutes } from "../routes/claims.js";
import { registerSynthesisRoutes } from "../routes/syntheses.js";
import { registerProposalRoutes } from "../routes/proposals.js";
import { registerGlobalMemoryRoutes } from "../routes/global-memory.js";
import { registerSignalRoutes } from "../routes/signals.js";

describe("routes-memory port batch", () => {
  it("registerMemoryRoutes lists workspace memories via typed service bag", async () => {
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const runService = { getById: vi.fn(async () => ({ run_id: "run-1" })) };
    const memoryService = {
      findByWorkspaceId: vi.fn(async () => [{ object_id: "m1" }]),
      findByDimension: vi.fn(async () => [{ object_id: "m2" }]),
      findByRunId: vi.fn(async () => [{ object_id: "m3" }]),
      findById: vi.fn(async () => ({ object_id: "m4" }))
    };

    const app = new Hono();
    registerMemoryRoutes(app, { workspaceService, runService, memoryService } as any);

    const response = await app.request("/workspaces/ws-1/memories?dimension=fact");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ object_id: "m2" }]
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(memoryService.findByDimension).toHaveBeenCalledWith("ws-1", "fact");
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
    registerRecallRoutes(app, {
      recallService,
      taskSurfaceBuilder,
      runService,
      workspaceService
    } as any);

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
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      runService: { getById: vi.fn(async () => ({ run_id: "run-1" })) },
      evidenceService: {
        findByWorkspaceId: vi.fn(),
        findByRunId: vi.fn(),
        findByIdScoped: vi.fn(async () => ({ object_id: "e1", workspace_id: "ws-1" }))
      }
    };
    registerEvidenceRoutes(app, services as any);

    const response = await app.request("/workspaces/ws-1/evidence/e1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "e1", workspace_id: "ws-1" }
    });
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(services.evidenceService.findByIdScoped).toHaveBeenCalledWith("e1", "ws-1");
  });

  it("registerEvidenceRoutes does not expose unscoped evidence by id", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      runService: { getById: vi.fn(async () => ({ run_id: "run-1" })) },
      evidenceService: {
        findByWorkspaceId: vi.fn(),
        findByRunId: vi.fn(),
        findById: vi.fn()
      }
    };
    registerEvidenceRoutes(app, services as any);

    const response = await app.request("/evidence/e1");
    expect(response.status).toBe(404);
    expect(services.evidenceService.findById).not.toHaveBeenCalled();
  });

  it("registerClaimRoutes resolves claims by id", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      claimService: { findByWorkspaceId: vi.fn(), findById: vi.fn(async () => ({ object_id: "c1" })) }
    };
    registerClaimRoutes(app, services as any);

    const response = await app.request("/claims/c1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "c1" }
    });
    expect(services.claimService.findById).toHaveBeenCalledWith("c1");
  });

  it("registerSynthesisRoutes resolves syntheses by id", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      synthesisService: { findByWorkspaceId: vi.fn(), findById: vi.fn(async () => ({ object_id: "s1" })) }
    };
    registerSynthesisRoutes(app, services as any);

    const response = await app.request("/syntheses/s1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { object_id: "s1" }
    });
    expect(services.synthesisService.findById).toHaveBeenCalledWith("s1");
  });

  it("registerProposalRoutes does not expose POST /proposals/:id/review", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      proposalService: {
        findByWorkspaceId: vi.fn(),
        findPending: vi.fn(),
        findById: vi.fn(),
        review: vi.fn(async () => {
          throw new Error("review must not be reachable from HTTP");
        })
      }
    };
    registerProposalRoutes(app, services as any);

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
    expect(services.proposalService.review).not.toHaveBeenCalled();
  });

  it("registerGlobalMemoryRoutes parses filters and applies default accepted_by", async () => {
    const app = new Hono();
    const services = {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      globalMemoryService: {
        list: vi.fn(async () => [{ object_id: "global-1" }]),
        adopt: vi.fn(async () => ({ object_id: "anchor-1" }))
      }
    };
    registerGlobalMemoryRoutes(app, services as any);

    const listResponse = await app.request("/soul/global-memory-entries?dimension=fact&scope_class=project&limit=5");
    expect(listResponse.status).toBe(200);
    expect(services.globalMemoryService.list).toHaveBeenCalledWith({
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
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(services.globalMemoryService.adopt).toHaveBeenCalledWith("global-1", {
      workspace_id: "ws-1",
      accepted_by: AcceptedBy.USER
    });
  });

  it("registerSignalRoutes lists run signals through signal service", async () => {
    const app = new Hono();
    const services = {
      runService: { getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" })) },
      signalService: { listByRun: vi.fn(async () => [{ signal_id: "sig-1" }]), receiveSignal: vi.fn() }
    };
    registerSignalRoutes(app, services as any);

    const response = await app.request("/runs/run-1/signals");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ signal_id: "sig-1" }]
    });
    expect(services.runService.getById).toHaveBeenCalledWith("run-1");
    expect(services.signalService.listByRun).toHaveBeenCalledWith("run-1");
  });
});
