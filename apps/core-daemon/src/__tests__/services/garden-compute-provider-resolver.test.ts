import { describe, expect, it, vi } from "vitest";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import {
  GardenProviderKind,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import { GardenComputeProviderResolver } from "../../services/garden-compute-provider-resolver.js";

describe("GardenComputeProviderResolver", () => {
  it("caches the provider for an unchanged runtime config", async () => {
    const configReader = createConfigReader({
      provider_kind: "official_api",
      provider_url: "https://proxy.example.test/v1",
      secret_ref: "env:GARDEN_KEY",
      model_id: "gpt-4o-mini",
      enabled: true
    });
    const makeProvider = vi.fn((config) => createProvider(`provider:${config.apiKey}:${config.model}`));
    const resolver = new GardenComputeProviderResolver({
      configReader,
      secretReader: vi.fn(() => "sk-one"),
      makeProvider
    });

    const first = await resolver.getProvider();
    const second = await resolver.getProvider();

    expect(first).toBe(second);
    expect(makeProvider).toHaveBeenCalledTimes(1);
    expect(makeProvider).toHaveBeenCalledWith({
      apiKey: "sk-one",
      model: "gpt-4o-mini",
      endpoint: "https://proxy.example.test/v1"
    });
  });

  it("rebuilds when secret_ref, model_id, provider_url, or invalidate changes the cache key", async () => {
    const configs: RuntimeGardenComputeConfig[] = [
      createOfficialConfig({ secret_ref: "env:GARDEN_ONE" }),
      createOfficialConfig({ secret_ref: "env:GARDEN_TWO" }),
      createOfficialConfig({ secret_ref: "env:GARDEN_TWO", model_id: "gpt-4.1-mini" }),
      createOfficialConfig({
        secret_ref: "env:GARDEN_TWO",
        model_id: "gpt-4.1-mini",
        provider_url: "https://proxy.example.test/v2"
      })
    ];
    let configIndex = 0;
    const configReader = {
      getRuntimeGardenComputeConfig: vi.fn(async () => configs[Math.min(configIndex++, configs.length - 1)]!)
    };
    const makeProvider = vi.fn((config) => createProvider(`provider:${config.apiKey}:${config.model}:${config.endpoint ?? "default"}`));
    const resolver = new GardenComputeProviderResolver({
      configReader,
      secretReader: vi.fn((secretRef) => `secret:${secretRef}`),
      makeProvider
    });

    const providers = [
      await resolver.getProvider(),
      await resolver.getProvider(),
      await resolver.getProvider(),
      await resolver.getProvider()
    ];
    resolver.invalidate();
    const afterInvalidate = await resolver.getProvider();

    expect(new Set(providers).size).toBe(4);
    expect(afterInvalidate).not.toBe(providers[3]);
    expect(makeProvider).toHaveBeenCalledTimes(5);
  });

  it("does not cache secret resolution failures", async () => {
    const configReader = createConfigReader(createOfficialConfig());
    const secretReader = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("bad secret");
      })
      .mockReturnValueOnce("sk-fixed");
    const makeProvider = vi.fn((config) => createProvider(`provider:${config.apiKey}`));
    const resolver = new GardenComputeProviderResolver({
      configReader,
      secretReader,
      makeProvider
    });

    await expect(resolver.getProvider()).rejects.toThrow("bad secret");
    await expect(resolver.getProvider()).resolves.toMatchObject({
      provider_kind: GardenProviderKind.OFFICIAL_API
    });
    expect(makeProvider).toHaveBeenCalledTimes(1);
  });

  it("reports provider_kind of the provider it currently serves", async () => {
    const fallbackProvider: GardenComputeProvider = {
      provider_kind: GardenProviderKind.LOCAL_HEURISTICS,
      compile: vi.fn(async () => [])
    };
    let config: RuntimeGardenComputeConfig = {
      provider_kind: "local_heuristics",
      provider_url: null,
      secret_ref: null,
      model_id: null,
      enabled: false
    };
    const resolver = new GardenComputeProviderResolver({
      configReader: { getRuntimeGardenComputeConfig: async () => config },
      fallbackProvider,
      secretReader: vi.fn(() => "sk-one"),
      makeProvider: vi.fn(() => createProvider("official"))
    });

    expect(resolver.provider_kind).toBe(GardenProviderKind.OFFICIAL_API);
    await expect(resolver.getProvider()).resolves.toBe(fallbackProvider);
    expect(resolver.provider_kind).toBe(GardenProviderKind.LOCAL_HEURISTICS);

    config = createOfficialConfig({ secret_ref: "env:GARDEN_KEY" });
    resolver.invalidate();
    await expect(resolver.getProvider()).resolves.toMatchObject({
      provider_kind: GardenProviderKind.OFFICIAL_API
    });
    expect(resolver.provider_kind).toBe(GardenProviderKind.OFFICIAL_API);
  });
});

function createConfigReader(config: RuntimeGardenComputeConfig): {
  getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
} {
  return {
    getRuntimeGardenComputeConfig: async () => config
  };
}

function createOfficialConfig(
  overrides: Partial<RuntimeGardenComputeConfig> = {}
): RuntimeGardenComputeConfig {
  return {
    provider_kind: "official_api",
    provider_url: null,
    secret_ref: "env:GARDEN_KEY",
    model_id: "gpt-4o-mini",
    enabled: true,
    ...overrides
  };
}

function createProvider(id: string): GardenComputeProvider {
  return {
    provider_kind: GardenProviderKind.OFFICIAL_API,
    compile: vi.fn(async () => [
      {
        signal_id: id,
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        source: "garden_compile",
        signal_kind: "potential_claim",
        object_kind: "note",
        scope_hint: null,
        domain_tags: [],
        confidence: 0.8,
        evidence_refs: [],
        raw_payload: {},
        created_at: "2026-05-11T00:00:00.000Z"
      }
    ]) as unknown as GardenComputeProvider["compile"]
  };
}
