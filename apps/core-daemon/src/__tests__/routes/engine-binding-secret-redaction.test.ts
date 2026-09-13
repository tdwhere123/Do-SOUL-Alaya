import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceRoutes } from "../../routes/workspace/workspaces.js";
import { workspaceRouteServices } from "../support/route-service-stubs.js";

describe("workspace engine-binding reads", () => {
  it("omits decrypted api_key from GET responses", async () => {
    const app = new Hono();
    registerWorkspaceRoutes(app, workspaceRouteServices({
      engineBindingService: {
        getWorkspaceBinding: vi.fn(async () => ({
          binding_id: "binding-1",
          workspace_id: "ws-1",
          provider_type: "openai",
          base_url: "https://api.openai.com/v1",
          api_key: "sk-live-secret",
          api_key_ref: "OPENAI_API_KEY",
          model: "gpt-4.1",
          config: {},
          created_at: "2026-05-05T00:00:00.000Z",
          updated_at: "2026-05-05T00:00:00.000Z"
        }))
      }
    }));

    const response = await app.request("/workspaces/ws-1/engine-binding");
    const body = await response.json() as { success: boolean; data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("api_key");
    expect(body.data.api_key_ref).toBe("OPENAI_API_KEY");
    expect(body.data.provider_type).toBe("openai");
    expect(body.data.base_url).toBe("https://api.openai.com/v1");
    expect(body.data.model).toBe("gpt-4.1");
  });
});
