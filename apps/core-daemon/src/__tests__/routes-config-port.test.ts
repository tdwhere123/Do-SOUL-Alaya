import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import { registerConfigRoutes } from "../routes/config.js";
import { createConfigService } from "../services/config-service.js";

describe("routes-config port batch", () => {
  it("forwards runtime embedding patch fields without dropping embedding_enabled", async () => {
    const configService = {
      getSoulConfig: vi.fn(),
      patchSoulConfig: vi.fn(),
      getStrategyConfig: vi.fn(),
      patchStrategyConfig: vi.fn(),
      getEnvironmentConfig: vi.fn(),
      patchEnvironmentConfig: vi.fn(),
      getRuntimeEmbeddingConfig: vi.fn(),
      patchRuntimeEmbeddingConfig: vi.fn(async (patch: unknown) => patch)
    };
    const app = new Hono();
    registerConfigRoutes(app, {
      workspaceService: { getById: vi.fn() },
      configService
    } as any);

    const body = {
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "secret://embedding/openai",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    };
    const response = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: body,
      requires_daemon_restart: true
    });
    expect(configService.patchRuntimeEmbeddingConfig).toHaveBeenCalledWith(body);
  });

  it("persists runtime embedding config through the config service envelope", async () => {
    const repo = createMemoryConfigRepo();
    const service = createConfigService({ configRepo: repo });

    await service.patchRuntimeEmbeddingConfig({
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "secret://embedding/openai",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });

    await expect(service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "secret://embedding/openai",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });
  });
});

function createMemoryConfigRepo(): ConfigRepo {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
    set: async <T>(key: string, value: T): Promise<void> => {
      values.set(key, value);
    },
    patch: async <T extends Record<string, unknown>>(
      key: string,
      partial: Partial<T>,
      defaults: T
    ): Promise<T> => {
      const current = (values.get(key) as T | undefined) ?? defaults;
      const next = { ...current, ...partial } as T;
      values.set(key, next);
      return next;
    }
  };
}
