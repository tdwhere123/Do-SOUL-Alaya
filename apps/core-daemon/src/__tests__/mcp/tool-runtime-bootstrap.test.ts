import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  getToolRuntimeWiringFixture,
  resetToolRuntimeWiringState
} from "./tool-runtime-wiring-fixture.js";

import { getBuiltinConversationToolSpecs } from "../../mcp/builtin-conversation-tool-specs.js";

import type { AlayaDaemonRuntime } from "../../runtime/daemon-runtime-types.js";

const hoisted = getToolRuntimeWiringFixture();

const activeRuntimes: Array<AlayaDaemonRuntime> = [];

const isolatedConfigDirs: string[] = [];

const BOOTSTRAP_TEST_TIMEOUT_MS = 15_000;

async function resolveBootGardenProvider(): Promise<unknown> {
  const provider = hoisted.conversationServiceDeps?.gardenComputeProvider as
    | { getProvider?: () => Promise<unknown> }
    | undefined;
  if (provider === undefined) {
    throw new Error("ConversationService gardenComputeProvider was not wired.");
  }
  if (typeof provider.getProvider === "function") {
    return await provider.getProvider();
  }
  return provider;
}

async function bootDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const { createAlayaDaemonRuntime } = await import("../../index.js");
  const runtime = await createAlayaDaemonRuntime();
  activeRuntimes.push(runtime);
  return runtime;
}

async function bootStartedDaemonRuntime(): Promise<AlayaDaemonRuntime> {
  const runtime = await bootDaemonRuntime();
  // @anchor test-port-zero — OS-assigned port avoids parallel bind race.
  // see also: apps/core-daemon/src/runtime/daemon-runtime-lifecycle.ts:startHttpServer
  await runtime.startHttpServer({ port: 0, allowEphemeralRequestToken: true });
  return runtime;
}

async function expectBootstrapDoesNotWaitForCjkWarmups(): Promise<void> {
  const coreGate = createDeferred<boolean>();
  const storageGate = createDeferred<boolean>();
  const configGate = createDeferred<ReadonlyMap<string, string>>();
  const coreCallsBefore = hoisted.coreWarmCjkSegmentation.mock.calls.length;
  const storageCallsBefore = hoisted.storageWarmCjkSegmentation.mock.calls.length;
  const configCallsBefore = hoisted.loadConfigEnv.mock.calls.length;

  hoisted.coreWarmCjkSegmentation.mockImplementationOnce(async () => coreGate.promise);
  hoisted.storageWarmCjkSegmentation.mockImplementationOnce(async () => storageGate.promise);
  hoisted.loadConfigEnv.mockImplementationOnce(
    async () => configGate.promise as unknown as Map<string, string>
  );

  let completed = false;
  const runtimePromise = bootDaemonRuntime().then((runtime) => {
    completed = true;
    return runtime;
  });

  try {
    await waitUntil(
      () =>
        hoisted.coreWarmCjkSegmentation.mock.calls.length === coreCallsBefore + 1 &&
        hoisted.storageWarmCjkSegmentation.mock.calls.length === storageCallsBefore + 1
    );
    await waitUntil(
      () => hoisted.loadConfigEnv.mock.calls.length === configCallsBefore + 1
    );
    expect(completed).toBe(false);

    configGate.resolve(new Map());
    await runtimePromise;
    expect(completed).toBe(true);
  } finally {
    coreGate.resolve(false);
    storageGate.resolve(false);
    configGate.resolve(new Map());
    await runtimePromise.catch(() => undefined);
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

describe("daemon tool runtime bootstrap", () => {

  beforeEach(async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-config-isolated-"));
    isolatedConfigDirs.push(configDir);
    process.env.ALAYA_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    for (const runtime of activeRuntimes.splice(0)) {
      await runtime.shutdown().catch(() => undefined);
    }
    vi.useRealTimers();
    resetToolRuntimeWiringState();
    // Reset the reconciliation off-switch here (not at the end of each test body)
    // so a thrown bootDaemonRuntime() cannot leak a disable value into a later
    // test that asserts the DEFAULT-ON behavior.
    delete process.env.ALAYA_INGEST_RECONCILIATION_ENABLED;
    for (const configDir of isolatedConfigDirs.splice(0)) {
      await rm(configDir, { force: true, recursive: true }).catch(() => undefined);
    }
  });

  it(
    "enrolls only allowed MCP servers into discovery and the model-visible registry",
    async () => {
    process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.ALAYA_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      },
      github: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-github-server.js"]
      }
    });
    hoisted.mcpRuntimeServerInfos.push(
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "active",
        registered_at: "2026-04-20T12:00:00.000Z"
      },
      {
        server_name: "github",
        transport_type: "stdio",
        status: "active",
        registered_at: "2026-04-20T12:00:01.000Z"
      }
    );
    hoisted.mcpRuntimeServerTools.set("filesystem", [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);
    hoisted.mcpRuntimeServerTools.set("github", [
      {
        name: "github.search_issues",
        description: "Search issues through GitHub MCP."
      }
    ]);
    hoisted.extensionProviders.push({
      provider_id: "provider.mcp.github",
      name: "GitHub MCP Provider",
      source: "mcp_external",
      tool_specs: [
        {
          tool_id: "mcp__github__search_issues",
          name: "github.search_issues",
          description: "Search issues through GitHub MCP."
        }
      ],
      requires_permission_check: true,
      records_execution: true,
      registered_at: "2026-04-20T11:59:00.000Z"
    });

    const runtime = await bootDaemonRuntime();

    const mcpDiscoverCalls = hoisted.mcpDiscoverAndRegister.mock.calls as readonly (readonly unknown[])[];
    expect(
      (mcpDiscoverCalls[0]?.[0] as readonly { readonly server_name: string }[]).map(
        (server) => server.server_name
      )
    ).toEqual(["filesystem"]);

    expect(
      (mcpDiscoverCalls.at(-1)?.[0] as readonly { readonly server_name: string }[]).map(
        (server) => server.server_name
      )
    ).toEqual(["filesystem"]);
    expect(runtime.services.conversationToolCatalog.getSpecs().map((spec) => spec.tool_id)).toContain(
      "mcp__filesystem__read_file"
    );
    expect(runtime.services.conversationToolCatalog.getSpecs().map((spec) => spec.tool_id)).not.toContain(
      "mcp__github__search_issues"
    );
    },
    BOOTSTRAP_TEST_TIMEOUT_MS
  );

  it(
    "boots ConversationService with the compute-routing resolver and no legacy stance resolver",
    async () => {
    // No garden secret in this boot -> the product default is host_worker, so
    // the compute-routing fallback provider is local_heuristics (the zero-cloud
    // in-process provider host_worker degrades to until a worker attaches).
    delete process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF;
    delete process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;

    await bootDaemonRuntime();

    expect(hoisted.conversationServiceDeps).toMatchObject({
      gardenComputeProvider: expect.objectContaining({
        provider_kind: "local_heuristics"
      }),
      resolveGardenComputeProvider: {
        resolve: expect.any(Function)
      }
    });
    expect(hoisted.conversationServiceDeps).not.toHaveProperty("engine");
    expect(hoisted.conversationServiceDeps).not.toHaveProperty("resolveExecutionStance");
    },
    BOOTSTRAP_TEST_TIMEOUT_MS
  );

  it(
    "wires the official_api garden provider through bootstrap and routing without an ad-hoc model env surface",
    async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:ALAYA_TEST_OPENAI_KEY";
    process.env.ALAYA_TEST_OPENAI_KEY = "sk-official";
    process.env.OFFICIAL_GARDEN_MODEL = "ignored-override";

    await bootDaemonRuntime();

    expect(hoisted.officialGardenProviderCtor).not.toHaveBeenCalled();
    await expect(resolveBootGardenProvider()).resolves.toBe(hoisted.officialGardenProviderInstance);
    expect(hoisted.officialGardenProviderCtor).toHaveBeenCalledWith({
      apiKey: "sk-official",
      model: "gpt-4.1-mini"
    });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(hoisted.computeRoutingServiceDeps).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          kind: "official_api",
          provider: expect.objectContaining({
            provider_kind: "official_api",
            getProvider: expect.any(Function)
          }),
          model_id: "gpt-4.1-mini",
          adapter: "garden.official_api"
        })
      ])
    });
    },
    BOOTSTRAP_TEST_TIMEOUT_MS
  );

  it("prefers the dedicated Garden secret-ref over the deprecated embedding fallback", async () => {
    process.env.ALAYA_GARDEN_OPENAI_SECRET_REF = "env:ALAYA_GARDEN_TEST_OPENAI_KEY";
    process.env.ALAYA_GARDEN_TEST_OPENAI_KEY = "sk-dedicated-garden";
    process.env.ALAYA_OPENAI_SECRET_REF = "env:ALAYA_TEST_OPENAI_KEY";
    process.env.ALAYA_TEST_OPENAI_KEY = "sk-embedding-fallback";

    await bootDaemonRuntime();

    expect(hoisted.officialGardenProviderCtor).not.toHaveBeenCalled();
    await expect(resolveBootGardenProvider()).resolves.toBe(hoisted.officialGardenProviderInstance);
    expect(hoisted.officialGardenProviderCtor).toHaveBeenCalledWith({
      apiKey: "sk-dedicated-garden",
      model: "gpt-4.1-mini"
    });
  });

  it("loads embedding secret-ref config from the Alaya config-dir .env during daemon bootstrap", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-config-env-"));
    isolatedConfigDirs.push(configDir);
    await writeFile(
      path.join(configDir, ".env"),
      [
        "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true",
        "ALAYA_OPENAI_SECRET_REF=env:ALAYA_TEST_OPENAI_KEY",
        "OPENAI_EMBEDDING_MODEL=text-embedding-3-large",
        "OPENAI_EMBEDDING_PROVIDER_URL=https://embedding.example.test/v1",
        ""
      ].join("\n"),
      "utf8"
    );
    process.env.ALAYA_CONFIG_DIR = configDir;
    process.env.ALAYA_TEST_OPENAI_KEY = "sk-config-file";
    delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
    delete process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_EMBEDDING_MODEL;
    delete process.env.OPENAI_EMBEDDING_PROVIDER_URL;

    await bootDaemonRuntime();

    expect(hoisted.officialGardenProviderCtor).not.toHaveBeenCalled();
    await expect(resolveBootGardenProvider()).resolves.toBe(hoisted.officialGardenProviderInstance);
    expect(hoisted.officialGardenProviderCtor).toHaveBeenCalledWith({
      apiKey: "sk-config-file",
      model: "gpt-4.1-mini"
    });
    expect(hoisted.computeRoutingServiceDeps).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          kind: "official_api",
          adapter: "garden.official_api"
        })
      ])
    });
  });

  it("falls back to local heuristics when the embedding fallback secret-ref is unresolvable", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-missing-provider-"));
    isolatedConfigDirs.push(configDir);
    await writeFile(
      path.join(configDir, ".env"),
      [
        "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true",
        "ALAYA_OPENAI_SECRET_REF=env:ALAYA_MISSING_OPENAI_KEY",
        ""
      ].join("\n"),
      "utf8"
    );
    process.env.ALAYA_CONFIG_DIR = configDir;
    delete process.env.ALAYA_MISSING_OPENAI_KEY;
    delete process.env.ALAYA_OPENAI_SECRET_REF;

    await bootDaemonRuntime();

    expect(hoisted.officialGardenProviderCtor).not.toHaveBeenCalled();
    expect(hoisted.computeRoutingServiceDeps).toMatchObject({
      providers: [
        expect.objectContaining({
          kind: "stub",
          adapter: "garden.local_heuristics"
        })
      ]
    });
  });

  it("hot-applies Garden compute PATCH by refreshing routing candidates without restart", async () => {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;

    const runtime = await bootDaemonRuntime();

    expect(hoisted.computeRoutingServiceDeps).toMatchObject({
      providers: [
        expect.objectContaining({
          kind: "stub",
          adapter: "garden.local_heuristics"
        })
      ]
    });

    process.env.ALAYA_TEST_OPENAI_KEY = "sk-patched-garden";
    const configService = (runtime as Awaited<ReturnType<typeof bootDaemonRuntime>> & {
      readonly services: {
        readonly configService: {
          patchRuntimeGardenComputeConfig(patch: unknown): Promise<unknown>;
        };
      };
    }).services.configService;
    await expect(configService.patchRuntimeGardenComputeConfig({
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "env:ALAYA_TEST_OPENAI_KEY",
      model_id: "gpt-4.1-mini",
      enabled: true
    })).resolves.toMatchObject({
      provider_kind: "official_api",
      secret_ref: "env:ALAYA_TEST_OPENAI_KEY",
      enabled: true
    });
    expect(hoisted.computeRoutingServiceSetProviders).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: "official_api",
        model_id: "gpt-4.1-mini",
        adapter: "garden.official_api"
      }),
      expect.objectContaining({
        kind: "stub",
        adapter: "garden.local_heuristics"
      })
    ]);
    expect(
      hoisted.conversationServiceDeps?.resolveGardenComputeProvider?.resolve(null)
    ).toMatchObject({
      provider_kind: "official_api"
    });
  });
});
