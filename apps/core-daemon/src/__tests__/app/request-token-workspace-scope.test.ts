import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../runtime/app.js";
import {
  extractWorkspaceIdFromPath,
  WORKSPACE_TOKEN_DENIED_MESSAGE
} from "../../runtime/request-token-binding.js";
import {
  globalMemoryRouteServices,
  runRouteServices
} from "../support/route-service-stubs.js";

const PROCESS_TOKEN = "process-token";

function headersFor(token: string): Record<string, string> {
  return {
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
        boundWorkspaceIds: ["wsA"]
      },
      routes: {
        files: {
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
        },
        projectMapping: {
          workspaceService: {
            getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
          },
          projectMappingService: {
            findByWorkspace: vi.fn(async () => [])
          }
        },
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
});
