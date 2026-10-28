import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputeProviderPriority,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
    const answer = { address: "93.184.216.34", family: 4 };
    return options?.all === true ? [answer] : answer;
  })
}));
import { LocalHeuristics } from "@do-soul/alaya-soul";
import {
  buildGardenComputeRoutingProviders,
  createConflictDetectionLlmPort
} from "../../runtime/garden-wiring/garden-compute-support.js";
import { GardenComputeProviderResolver } from "../../services/support/garden-compute-provider-resolver.js";
import { mergeDaemonEnvLookup } from "../../runtime/config/daemon-config-environment.js";

const environment = process.env;
beforeEach(() => { process.env = {}; });
afterEach(() => { process.env = environment; vi.restoreAllMocks(); });

describe("createConflictDetectionLlmPort", () => {
  it.each([false, true])("uses file conflict settings with process precedence (process override=%s)", async override => {
    const configEnv = new Map([
      ["ALAYA_CONFLICT_LLM_PROVIDER_URL", "https://conflict.example.test/v1"],
      ["ALAYA_CONFLICT_LLM_MODEL", "file-conflict-model"],
      ["ALAYA_CONFLICT_LLM_API_KEY", "fixture-only"],
      ["ALAYA_CONFLICT_LLM_TIMEOUT_MS", "60"]
    ]);
    if (override) process.env.ALAYA_CONFLICT_LLM_MODEL = "process-conflict-model";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "none" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const port = createConflictDetectionLlmPort(mergeDaemonEnvLookup(process.env, configEnv));
    await expect(port?.classifyPair(createPairInput())).resolves.toBe("none");
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe(override ? "process-conflict-model" : "file-conflict-model");
  });

  it("does not use a config-file value as an env secret-ref target", () => {
    const configEnv = new Map([
      ["ALAYA_CONFLICT_LLM_PROVIDER_URL", "https://conflict.example.test/v1"],
      ["ALAYA_CONFLICT_LLM_MODEL", "file-conflict-model"],
      ["ALAYA_CONFLICT_LLM_SECRET_REF", "env:CONFLICT_FILE_VALUE"],
      ["CONFLICT_FILE_VALUE", "fixture-only"]
    ]);
    expect(createConflictDetectionLlmPort(mergeDaemonEnvLookup(process.env, configEnv))).toBeNull();
  });
  it("unrefs the conflict request timeout so classification does not pin shutdown", async () => {
    configureConflictLlmEnv();
    const unref = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((...args: Parameters<typeof setTimeout>) => {
        const handle = originalSetTimeout(...args);
        return Object.assign(handle, { unref }) as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "none" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const port = createConflictDetectionLlmPort();

    await expect(port?.classifyPair(createPairInput())).resolves.toBe("none");
    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();
  });

  it.each(["ALAYA_CONFLICT_LLM_PROVIDER_URL", "ALAYA_CONFLICT_LLM_MODEL"])(
    "skips missing or blank %s without reading credentials", key => {
      configureConflictLlmEnv();
      const forbiddenRead = vi.fn(() => { throw new Error("unused conflict credential lookup"); });
      for (const credential of ["ALAYA_CONFLICT_LLM_SECRET_REF", "ALAYA_CONFLICT_LLM_API_KEY"]) {
        Object.defineProperty(process.env, credential, { get: forbiddenRead, configurable: true });
      }
      for (const value of [undefined, "   "]) {
        restoreEnv(key, value);
        expect(createConflictDetectionLlmPort()).toBeNull();
      }
      expect(forbiddenRead).not.toHaveBeenCalled();
    }
  );

  it.each(["secret_ref", "raw_key"] as const)("retains configured %s credential selection and timeout", async mode => {
    configureConflictLlmEnv();
    if (mode === "secret_ref") {
      process.env.ALAYA_CONFLICT_LLM_SECRET_REF = "env:CONFLICT_FIXTURE_VALUE";
      process.env.CONFLICT_FIXTURE_VALUE = "fixture-reference-value";
      Object.defineProperty(process.env, "ALAYA_CONFLICT_LLM_API_KEY", {
        get: () => { throw new Error("raw key must not override selected secret reference"); }
      });
    } else {
      process.env.ALAYA_CONFLICT_LLM_SECRET_REF = "   ";
    }
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "none" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const port = createConflictDetectionLlmPort();
    expect(port).not.toBeNull();
    await expect(port?.classifyPair(createPairInput())).resolves.toBe("none");
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe(`Bearer ${mode === "secret_ref" ? "fixture-reference-value" : "sk-conflict-test"}`);
    expect(timeout.mock.calls.some(([, milliseconds]) => milliseconds === 50)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not fall back to a raw key when the selected secret reference cannot resolve", () => {
    configureConflictLlmEnv();
    process.env.ALAYA_CONFLICT_LLM_SECRET_REF = "env:ABSENT_CONFLICT_FIXTURE_VALUE";
    expect(createConflictDetectionLlmPort()).toBeNull();
  });

  it("forwards the configured conflict model when the env var is set", async () => {
    configureConflictLlmEnv();
    process.env.ALAYA_CONFLICT_LLM_MODEL = "conflict-test-model";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "none" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const port = createConflictDetectionLlmPort();

    await expect(port?.classifyPair(createPairInput())).resolves.toBe("none");
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "conflict-test-model",
      temperature: 0,
      max_tokens: 8,
      messages: [
        { role: "system", content: "Reply with exactly one word." },
        { role: "user", content: expect.stringContaining("MEMORY_A (new)") }
      ]
    });
    expect(body).not.toHaveProperty("response_format");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider down", {
      status: 503,
      statusText: "Service Unavailable"
    }));
    const port = createConflictDetectionLlmPort();

    await expect(port?.classifyPair(createPairInput())).rejects.toThrow(
      "Conflict detection LLM HTTP 503 Service Unavailable"
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
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
