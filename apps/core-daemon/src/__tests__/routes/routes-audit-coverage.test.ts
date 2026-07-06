import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcceptedBy,
  FileApprovalEventType,
  ObligationTrustNarrativeEventType,
  ProjectMappingState
} from "@do-soul/alaya-protocol";
import { StrictConfirmationRequired } from "@do-soul/alaya-core";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import {
  registerE2eEventTriggerRoutes,
  type E2eEventTriggerRouteServices
} from "../../routes/workspace/e2e-event-triggers.js";
import { registerProjectMappingRoutes } from "../../routes/workspace/project-mapping.js";
import { registerSoulRoutes } from "../../routes/memory/soul.js";

function appWithErrors(): Hono {
  const app = new Hono();
  registerErrorHandler(app, { error: vi.fn() });
  return app;
}

function suppressE2eWarning(): void {
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
}

function e2eServices(): E2eEventTriggerRouteServices & {
  readonly appendOrder: string[];
} {
  const appendOrder: string[] = [];
  return {
    appendOrder,
    runService: {
      getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "ws-e2e" }))
    },
    workspaceService: {
      getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
    },
    eventLogRepo: {
      append: vi.fn(async (event) => {
        appendOrder.push("append");
        return {
          ...event,
          event_id: "evt-1",
          created_at: "2026-07-06T00:00:00.000Z",
          revision: event.revision ?? 1
        };
      })
    },
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => {
        appendOrder.push("notify");
      })
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audit-covered route contracts", () => {
  it("E2E approval trigger validates the run workspace, appends EventLog, then notifies", async () => {
    suppressE2eWarning();
    const app = appWithErrors();
    const services = e2eServices();
    registerE2eEventTriggerRoutes(app, services);

    const response = await app.request("/__e2e/events/soul-approval-requested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-1",
        approval_id: "approval-1",
        message_id: "message-1",
        description: "Approve this fixture action"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        event_id: "evt-1",
        approval_id: "approval-1",
        message_id: "message-1",
        run_id: "run-1"
      }
    });
    expect(services.workspaceService.getById).toHaveBeenCalledWith("ws-e2e");
    expect(services.eventLogRepo.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: FileApprovalEventType.SOUL_APPROVAL_REQUESTED,
      entity_type: "approval",
      entity_id: "approval-1",
      workspace_id: "ws-e2e",
      run_id: "run-1",
      caused_by: "e2e_event_trigger",
      payload_json: expect.objectContaining({ approval_id: "approval-1", run_id: "run-1" })
    }));
    expect(services.runtimeNotifier.notifyEntry).toHaveBeenCalledWith(expect.objectContaining({
      event_id: "evt-1"
    }));
    expect(services.appendOrder).toEqual(["append", "notify"]);
  });

  it("E2E dirty-state trigger rejects malformed bodies before EventLog append", async () => {
    suppressE2eWarning();
    const app = appWithErrors();
    const services = e2eServices();
    registerE2eEventTriggerRoutes(app, services);

    const response = await app.request("/__e2e/events/dirty-state-panic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ affected_entity_count: -1 })
    });

    expect(response.status).toBe(400);
    expect(services.runService.getById).not.toHaveBeenCalled();
    expect(services.eventLogRepo.append).not.toHaveBeenCalled();
    expect(services.runtimeNotifier.notifyEntry).not.toHaveBeenCalled();
  });

  it("E2E dirty-state trigger appends the typed panic EventLog payload", async () => {
    suppressE2eWarning();
    const app = appWithErrors();
    const services = e2eServices();
    registerE2eEventTriggerRoutes(app, services);

    const response = await app.request("/__e2e/events/dirty-state-panic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_id: "run-2",
        dossier_id: "dossier-1",
        worker_run_id: "worker-run-1",
        panic_summary: "Dirty state fixture",
        affected_entity_count: 2
      })
    });

    expect(response.status).toBe(201);
    expect(services.eventLogRepo.append).toHaveBeenCalledWith(expect.objectContaining({
      event_type: ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC,
      entity_type: "worker_run",
      entity_id: "worker-run-1",
      workspace_id: "ws-e2e",
      run_id: "run-2",
      payload_json: expect.objectContaining({
        dossier_id: "dossier-1",
        worker_run_id: "worker-run-1",
        principal_run_id: "run-2",
        affected_entity_count: 2
      })
    }));
  });

  it("project mapping list is workspace-protected and forwards the optional state filter", async () => {
    const app = appWithErrors();
    const workspaceService = { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) };
    const projectMappingService = {
      findByWorkspace: vi.fn(async () => [{ object_id: "anchor-1", mapping_state: ProjectMappingState.SUGGESTED }])
    };
    registerProjectMappingRoutes(app, { workspaceService, projectMappingService } as never);

    const response = await app.request(
      `/soul/project-mapping-anchors?workspace_id=ws-1&mapping_state=${ProjectMappingState.SUGGESTED}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { anchors: [{ object_id: "anchor-1", mapping_state: ProjectMappingState.SUGGESTED }], total: 1 }
    });
    expect(workspaceService.getById).toHaveBeenCalledWith("ws-1");
    expect(projectMappingService.findByWorkspace).toHaveBeenCalledWith("ws-1", ProjectMappingState.SUGGESTED);
  });

  it("project mapping transition binds mutations to the path workspace", async () => {
    const app = appWithErrors();
    const projectMappingService = {
      accept: vi.fn(async () => ({ object_id: "anchor-1", mapping_state: "accepted" }))
    };
    registerProjectMappingRoutes(app, {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-2" })) },
      projectMappingService
    } as never);

    const response = await app.request("/workspaces/ws-2/soul/project-mapping-anchors/anchor-1/transition", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept" })
    });

    expect(response.status).toBe(200);
    expect(projectMappingService.accept).toHaveBeenCalledWith("anchor-1", AcceptedBy.USER, "ws-2");
  });

  it("project mapping batch accept returns strict-confirmation ids without mutating the response shape", async () => {
    const app = appWithErrors();
    const projectMappingService = {
      batchAccept: vi.fn(async () => {
        throw new StrictConfirmationRequired(["anchor-strict"]);
      })
    };
    registerProjectMappingRoutes(app, {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-1" })) },
      projectMappingService
    } as never);

    const response = await app.request("/soul/project-mapping-anchors/batch-accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "ws-1", mapping_ids: ["anchor-strict"] })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Strict confirmation required",
      strictIds: ["anchor-strict"]
    });
    expect(projectMappingService.batchAccept).toHaveBeenCalledWith(["anchor-strict"], AcceptedBy.USER);
  });

  it("soul graph-neighbor route checks workspace scope and parses direction plus edge filters", async () => {
    const app = appWithErrors();
    const graphExploreService = {
      exploreOneHop: vi.fn(async () => [{
        memory_id: "neighbor-1",
        edge_id: "edge-1",
        edge_type: "supports" as const,
        direction: "outbound" as const
      }])
    };
    registerSoulRoutes(app, {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-graph" })) },
      graphExploreService
    });

    const response = await app.request(
      "/workspaces/ws-graph/soul/memories/memory-1/graph-neighbors?direction=outbound&edge_types=supports&edge_types=contradicts"
    );

    expect(response.status).toBe(200);
    expect(graphExploreService.exploreOneHop).toHaveBeenCalledWith("memory-1", "ws-graph", {
      direction: "outbound",
      edgeTypes: ["supports", "contradicts"]
    });
  });

  it("soul approval route binds the approval action to user_action and request workspace", async () => {
    const app = appWithErrors();
    const approvalService = {
      approve: vi.fn(async () => ({
        approval_id: "approval-1",
        result: "approved" as const,
        resolved_at: "2026-07-06T00:00:00.000Z"
      })),
      reject: vi.fn()
    };
    registerSoulRoutes(app, {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-approval" })) },
      approvalService
    });

    const response = await app.request("/workspaces/ws-approval/soul/approval/approval-1/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run-approval" })
    });

    expect(response.status).toBe(200);
    expect(approvalService.approve).toHaveBeenCalledWith({
      approvalId: "approval-1",
      runId: "run-approval",
      workspaceId: "ws-approval",
      causedBy: "user_action"
    });
  });

  it("soul topology route fails closed when audit logging is not wired", () => {
    const app = appWithErrors();

    expect(() =>
      registerSoulRoutes(app, {
        workspaceService: { getById: vi.fn() },
        topologyService: { explore: vi.fn() }
      })
    ).toThrow("TopologyService requires topology audit logging.");
  });
});
