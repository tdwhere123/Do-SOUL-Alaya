import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../runtime/app.js";
import {
  extractWorkspaceIdFromPath,
  WORKSPACE_TOKEN_DENIED_MESSAGE
} from "../../runtime/request-token-binding.js";
import type { BudgetRouteServices } from "../../routes/governance/matrix/budget.js";
import type { OverrideRouteServices } from "../../routes/governance/matrix/overrides.js";
import type { FileRouteServices } from "../../routes/workspace/files/files.js";
import type { ProjectMappingRouteServices } from "../../routes/workspace/project-mapping.js";
import type { SoulSearchRouteServices } from "../../routes/memory/soul/soul-search.js";
import {
  globalMemoryRouteServices,
  routeServices,
  runRouteServices,
  workspaceServiceStub
} from "../support/route-service-stubs.js";

const PROCESS_TOKEN = "process-token";

function headersFor(token: string): Record<string, string> {
  return {
    // Originless desktop is denied before workspace grant; Inspector sends Origin.
    origin: "http://localhost:5173",
    "x-request-token": token,
    "x-alaya-desktop": "1",
    "content-type": "application/json"
  };
}

describe("request token workspace scope", () => {
  it("returns null for a malformed percent-encoded workspace path", () => {
    expect(extractWorkspaceIdFromPath("/workspaces/%ZZ/files")).toBeNull();
  });

  it("rejects body, query, and run workspace ids outside the token grant", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: PROCESS_TOKEN,
        boundWorkspaceIds: ["wsA"],
        allowDesktopOriginlessRequests: true
      },
      routes: {
        files: routeServices<FileRouteServices>({
          workspaceService: {
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          },
          runService: {
            getById: vi.fn(async () => ({ run_id: "run-b", workspace_id: "wsB" }))
          },
          fileRepo: {
            findById: vi.fn(async () => null)
          },
          eventLogRepo: {
            append: vi.fn()
          },
          runtimeNotifier: {
            notifyEntry: vi.fn()
          },
          filesDirectory: "/tmp/files"
        }),
        projectMapping: routeServices<ProjectMappingRouteServices>({
          workspaceService: workspaceServiceStub({
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          }),
          projectMappingService: {
            findByWorkspace: vi.fn(async () => [])
          }
        }),
        globalMemory: globalMemoryRouteServices({
          workspaceService: {
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          },
          globalMemoryService: {
            adopt: vi.fn()
          }
        }),
        runs: runRouteServices({
          runService: {
            getById: vi.fn(async () => ({ run_id: "run-b", workspace_id: "wsB" }))
          },
          workspaceService: {
            getById: vi.fn(async () => ({ workspace_id: "wsB" }))
          }
        })
      }
    });

    const files = await app.request("/files/file-1?workspace_id=wsB", {
      headers: headersFor(PROCESS_TOKEN)
    });
    const mapping = await app.request("/soul/project-mapping-anchors?workspace_id=wsB", {
      headers: headersFor(PROCESS_TOKEN)
    });
    const adopt = await app.request("/soul/global-memory-entries/mem-1/adopt", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({ workspace_id: "wsB" })
    });
    const run = await app.request("/runs/run-b", {
      headers: headersFor(PROCESS_TOKEN)
    });

    expect(files.status).toBe(403);
    expect(mapping.status).toBe(403);
    expect(adopt.status).toBe(403);
    expect(run.status).toBe(403);
    await expect(files.json()).resolves.toEqual({
      success: false,
      error: WORKSPACE_TOKEN_DENIED_MESSAGE
    });
  });

  it("does not treat nested body workspace_id as a grant or as the adopt target", async () => {
    const adopt = vi.fn();
    const create = vi.fn();
    const searchCall = vi.fn(async () => ({ ok: true, output: { hits: [] } }));
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: PROCESS_TOKEN,
        boundWorkspaceIds: ["wsA"],
        allowDesktopOriginlessRequests: true
      },
      routes: {
        globalMemory: globalMemoryRouteServices({
          workspaceService: {
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          },
          globalMemoryService: { adopt }
        }),
        projectMapping: routeServices<ProjectMappingRouteServices>({
          workspaceService: workspaceServiceStub({
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          }),
          projectMappingService: { suggest: create }
        }),
        soulSearch: routeServices<SoulSearchRouteServices>({
          workspaceService: {
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          },
          mcpMemoryToolHandler: { call: searchCall }
        })
      }
    });

    const nestedAdopt = await app.request("/soul/global-memory-entries/mem-1/adopt", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({ payload: { workspace_id: "wsB" } })
    });
    const nestedMapping = await app.request("/soul/project-mapping-anchors", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({
        global_object_id: "global-1",
        filter: { workspace_id: "wsB" }
      })
    });
    const nestedSearch = await app.request("/workspaces/wsA/soul/search", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({ text: "hello", filter: { workspace_id: "wsB" } })
    });

    expect(nestedAdopt.status).toBe(400);
    expect(adopt).not.toHaveBeenCalled();
    expect(nestedMapping.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(nestedSearch.status).toBe(200);
    expect(searchCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "soul.recall",
        context: expect.objectContaining({ workspaceId: "wsA" })
      })
    );
  });

  it("rejects override and budget run-id grants outside the token workspace", async () => {
    const apply = vi.fn();
    const resolve = vi.fn();
    const getSnapshot = vi.fn();
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: PROCESS_TOKEN,
        boundWorkspaceIds: ["wsA"],
        allowDesktopOriginlessRequests: true
      },
      routes: {
        overrides: routeServices<OverrideRouteServices>({
          runService: {
            getById: vi.fn(async () => ({ run_id: "run-b", workspace_id: "wsB" }))
          },
          sessionOverrideService: { apply }
        }),
        budget: routeServices<BudgetRouteServices>({
          runService: {
            getById: vi.fn(async () => ({ run_id: "run-b", workspace_id: "wsB" }))
          },
          budgetBankruptcyService: { getSnapshot, resolve }
        })
      }
    });

    const override = await app.request("/runs/run-b/overrides", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({
        target_object: "memory-1",
        correction: "prefer concise answers"
      })
    });
    const snapshot = await app.request("/runs/run-b/budget-snapshot", {
      headers: headersFor(PROCESS_TOKEN)
    });
    const bankruptcy = await app.request("/runs/run-b/budget-bankruptcy/resolve", {
      method: "POST",
      headers: headersFor(PROCESS_TOKEN),
      body: JSON.stringify({ option_id: "option-1", action: "accept" })
    });

    expect(override.status).toBe(403);
    expect(snapshot.status).toBe(403);
    expect(bankruptcy.status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    await expect(override.json()).resolves.toEqual({
      success: false,
      error: WORKSPACE_TOKEN_DENIED_MESSAGE
    });
  });
});
