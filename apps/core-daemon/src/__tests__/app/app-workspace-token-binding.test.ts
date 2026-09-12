import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../runtime/app.js";
import { appConfigServiceStub } from "../support/app-config-service-stub.js";
import { configRouteServices } from "../support/route-service-stubs.js";

const PROCESS_TOKEN = "process-token";
const WORKSPACE_A_TOKEN = "workspace-a-token";
const WORKSPACE_B_TOKEN = "workspace-b-token";

function createBoundApp() {
  const patchRuntimeEmbeddingConfig = vi.fn(async (patch: unknown) => ({
    config_version: 1 as const,
    embedding_enabled: false,
    model_id: null,
    provider_url: null,
    secret_ref: null,
    ...(patch as { embedding_enabled?: boolean })
  }));
  const app = createApp({
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: PROCESS_TOKEN,
      boundWorkspaceIds: ["ws-default"],
      allowProcessSecretPatch: true,
      workspaceTokens: [
        { token: WORKSPACE_A_TOKEN, workspaceIds: ["ws-a"] },
        { token: WORKSPACE_B_TOKEN, workspaceIds: ["ws-b"] }
      ]
    },
    routes: {
      config: configRouteServices({
        configService: appConfigServiceStub({
          patchRuntimeEmbeddingConfig
        })
      })
    }
  });
  return { app, patchRuntimeEmbeddingConfig };
}

function headersFor(token: string): Record<string, string> {
  return {
    "x-request-token": token,
    "x-alaya-desktop": "1"
  };
}

describe("daemon workspace-bound request tokens", () => {
  it("rejects a workspace A token against workspace B routes", async () => {
    const { app } = createBoundApp();

    const allowed = await app.request("/workspaces/ws-a/memories", {
      headers: headersFor(WORKSPACE_A_TOKEN)
    });
    const forbidden = await app.request("/workspaces/ws-b/memories", {
      headers: headersFor(WORKSPACE_A_TOKEN)
    });

    expect(allowed.status).toBe(404);
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      success: false,
      error: "Workspace is not authorized for this token"
    });
  });

  it("rejects an Inspector workspace token from PATCHing process-level secrets", async () => {
    const { app, patchRuntimeEmbeddingConfig } = createBoundApp();

    const inspectorPatch = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: {
        ...headersFor(WORKSPACE_A_TOKEN),
        "content-type": "application/json"
      },
      body: JSON.stringify({ embedding_enabled: true })
    });
    const processPatch = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: {
        ...headersFor(PROCESS_TOKEN),
        "content-type": "application/json"
      },
      body: JSON.stringify({ embedding_enabled: true })
    });

    expect(inspectorPatch.status).toBe(403);
    await expect(inspectorPatch.json()).resolves.toEqual({
      success: false,
      error: "Process-level secret patch is not allowed"
    });
    expect(processPatch.status).toBe(200);
    expect(patchRuntimeEmbeddingConfig).toHaveBeenCalledTimes(1);
  });

  it("does not let the default-workspace process token hit an arbitrary workspace id", async () => {
    const { app } = createBoundApp();

    const allowed = await app.request("/workspaces/ws-default/memories", {
      headers: headersFor(PROCESS_TOKEN)
    });
    const forbidden = await app.request("/workspaces/ws-a/memories", {
      headers: headersFor(PROCESS_TOKEN)
    });

    expect(allowed.status).toBe(404);
    expect(forbidden.status).toBe(403);
  });
});
