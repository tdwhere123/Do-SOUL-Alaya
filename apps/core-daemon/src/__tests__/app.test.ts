import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AppConfigService } from "../services/config-service.js";

describe("createApp", () => {
  it("requires a timing-safe request token for mutating routes", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const missing = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173"
      }
    });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });

    const wrong = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "wrong-token"
      }
    });
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toEqual({
      success: false,
      error: "Invalid X-Request-Token"
    });
  });

  it("exposes request token only to allowed local origins", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        origin: "http://localhost:5173"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        request_token: "secret-token"
      }
    });
  });

  it("registers typed route service bags on the Hono app", async () => {
    const patchRuntimeEmbeddingConfig = vi.fn(
      async (patch: unknown): Promise<Readonly<{
        embedding_enabled: boolean;
        model_id: string | null;
        provider_url: string | null;
        secret_ref: string | null;
      }>> => patch as Readonly<{
        embedding_enabled: boolean;
        model_id: string | null;
        provider_url: string | null;
        secret_ref: string | null;
      }>
    );
    const app = createApp({
      routes: {
        config: {
          workspaceService: { getById: vi.fn() } as any,
          configService: {
            getSoulConfig: vi.fn(),
            patchSoulConfig: vi.fn(),
            getStrategyConfig: vi.fn(),
            patchStrategyConfig: vi.fn(),
            getEnvironmentConfig: vi.fn(),
            patchEnvironmentConfig: vi.fn(),
            getRuntimeEmbeddingConfig: vi.fn(),
            patchRuntimeEmbeddingConfig,
            getGardenCredentialProvenance: vi.fn(async () => ({ kind: "none" as const }))
          } as unknown as AppConfigService
        }
      }
    });

    const response = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embedding_enabled: true })
    });

    expect(response.status).toBe(200);
    expect(patchRuntimeEmbeddingConfig).toHaveBeenCalledWith({ embedding_enabled: true });
  });
});
