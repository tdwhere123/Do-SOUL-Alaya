import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputeProviderPriority,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { LocalHeuristics } from "@do-soul/alaya-soul";
import {
  buildGardenComputeRoutingProviders,
  createConflictDetectionLlmPort
} from "../../runtime/garden-compute-support.js";
import { GardenComputeProviderResolver } from "../../services/garden-compute-provider-resolver.js";

const originalConflictProviderUrl = process.env.ALAYA_CONFLICT_LLM_PROVIDER_URL;
const originalConflictApiKey = process.env.ALAYA_CONFLICT_LLM_API_KEY;
const originalConflictModel = process.env.ALAYA_CONFLICT_LLM_MODEL;
const originalConflictTimeout = process.env.ALAYA_CONFLICT_LLM_TIMEOUT_MS;
const originalMissingGardenKey = process.env.ALAYA_MISSING_GARDEN_KEY;

afterEach(() => {
  restoreEnv("ALAYA_CONFLICT_LLM_PROVIDER_URL", originalConflictProviderUrl);
  restoreEnv("ALAYA_CONFLICT_LLM_API_KEY", originalConflictApiKey);
  restoreEnv("ALAYA_CONFLICT_LLM_MODEL", originalConflictModel);
  restoreEnv("ALAYA_CONFLICT_LLM_TIMEOUT_MS", originalConflictTimeout);
  restoreEnv("ALAYA_MISSING_GARDEN_KEY", originalMissingGardenKey);
  vi.restoreAllMocks();
});

describe("createConflictDetectionLlmPort", () => {
  it("rejects transport failures instead of returning a no-conflict verdict", async () => {
    configureConflictLlmEnv();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const port = createConflictDetectionLlmPort();

    await expect(port?.classifyPair(createPairInput())).rejects.toThrow(
      "Conflict detection LLM request failed"
    );
  });

  it("rejects non-OK responses instead of returning a no-conflict verdict", async () => {
    configureConflictLlmEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider down", {
      status: 503,
      statusText: "Service Unavailable"
    }));
    const port = createConflictDetectionLlmPort();

    await expect(port?.classifyPair(createPairInput())).rejects.toThrow(
      "Conflict detection LLM HTTP 503 Service Unavailable"
    );
  });
});

describe("buildGardenComputeRoutingProviders", () => {
  it("warns when the official Garden secret cannot resolve and keeps local fallback routing", () => {
    restoreEnv("ALAYA_MISSING_GARDEN_KEY", undefined);
    const warn = vi.fn();
    const providers = buildGardenComputeRoutingProviders({
      config: createOfficialGardenConfig({ secret_ref: "env:ALAYA_MISSING_GARDEN_KEY" }),
      officialGardenProvider: createOfficialResolver(),
      localHeuristicsProvider: new LocalHeuristics(),
      warn
    });

    expect(providers.map((provider) => provider.kind)).toEqual([ComputeProviderPriority.STUB]);
    expect(warn).toHaveBeenCalledWith(
      "garden official provider secret_ref resolve failed",
      expect.objectContaining({
        provider_kind: "official_api",
        secret_ref: "env:ALAYA_MISSING_GARDEN_KEY",
        reason: expect.stringContaining("missing environment variable")
      })
    );
  });
});

function configureConflictLlmEnv(): void {
  process.env.ALAYA_CONFLICT_LLM_PROVIDER_URL = "https://conflict.example.test/v1";
  process.env.ALAYA_CONFLICT_LLM_API_KEY = "sk-conflict-test";
  process.env.ALAYA_CONFLICT_LLM_MODEL = "test-model";
  process.env.ALAYA_CONFLICT_LLM_TIMEOUT_MS = "50";
}

function createPairInput(): Parameters<NonNullable<ReturnType<typeof createConflictDetectionLlmPort>>["classifyPair"]>[0] {
  return {
    newContent: "The user prefers dark roast coffee.",
    existingContent: "The user prefers light roast coffee.",
    dimension: "preference",
    scopeClass: "project"
  };
}

function createOfficialGardenConfig(
  overrides: Partial<RuntimeGardenComputeConfig> = {}
): RuntimeGardenComputeConfig {
  return {
    provider_kind: "official_api",
    model_id: "garden-model",
    provider_url: "https://garden.example.test/v1",
    secret_ref: "env:ALAYA_MISSING_GARDEN_KEY",
    enabled: true,
    ...overrides
  };
}

function createOfficialResolver(): GardenComputeProviderResolver {
  // The routing builder only stores the resolver as a candidate and never resolves
  // through it in this test path, so the dependencies are inert stubs.
  return new GardenComputeProviderResolver({
    configReader: { getRuntimeGardenComputeConfig: vi.fn() },
    secretReader: vi.fn(),
    makeProvider: vi.fn(() => new LocalHeuristics())
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
