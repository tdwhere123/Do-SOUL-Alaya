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
  const createAlayaDaemonRuntime = await loadDaemonRuntimeFactory();
  const runtime = await createAlayaDaemonRuntime();
  activeRuntimes.push(runtime);
  return runtime;
}

async function loadDaemonRuntimeFactory(): Promise<() => Promise<AlayaDaemonRuntime>> {
  const { createAlayaDaemonRuntime } = await import("../../index.js");
  return createAlayaDaemonRuntime;
}

async function installWarnLoggerSpy() {
  const runtimeHelpers = await import("../../runtime/daemon-runtime-helpers.js");
  const warn = vi.fn();
  vi.spyOn(runtimeHelpers, "createWarnLogger").mockReturnValue({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    fatal: vi.fn()
  });
  return warn;
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

  it("does not await embedding warmup and stays quiet when warmup reports a normal failed status", async () => {
    const warn = await installWarnLoggerSpy();
    const createAlayaDaemonRuntime = await loadDaemonRuntimeFactory();
    const providerWarmup = createDeferred<"ready" | "failed">();
    hoisted.createDaemonEmbeddingRuntimeOverride = () => ({
      embeddingStatusService: {},
      embeddingRecallService: undefined,
      embeddingBackfillHandler: undefined,
      defaultPolicyDecorator: undefined,
      providerWarmup: providerWarmup.promise
    });

    let bootResolved = false;
    const runtimePromise = createAlayaDaemonRuntime().then((runtime) => {
      activeRuntimes.push(runtime);
      bootResolved = true;
      return runtime;
    });

    try {
      await vi.waitFor(() => {
        expect(bootResolved).toBe(true);
      });
      const runtime = await runtimePromise;
      expect(runtime.services.embeddingProviderWarmup).toBe(providerWarmup.promise);

      providerWarmup.resolve("failed");
      await Promise.resolve();

      expect(warn).not.toHaveBeenCalledWith(
        "embedding provider warmup ready",
        expect.any(Object)
      );
      expect(warn).not.toHaveBeenCalledWith(
        "embedding provider warmup observer failed",
        expect.any(Object)
      );
      await expect(runtimePromise).resolves.toBeDefined();
    } finally {
      providerWarmup.resolve("failed");
      await runtimePromise.catch(() => undefined);
    }
  });

  it("logs unexpected embedding warmup observer failures without blocking boot", async () => {
    const warn = await installWarnLoggerSpy();
    const createAlayaDaemonRuntime = await loadDaemonRuntimeFactory();
    const providerWarmup = createDeferred<"ready" | "failed">();
    hoisted.createDaemonEmbeddingRuntimeOverride = () => ({
      embeddingStatusService: {},
      embeddingRecallService: undefined,
      embeddingBackfillHandler: undefined,
      defaultPolicyDecorator: undefined,
      providerWarmup: providerWarmup.promise
    });

    let bootResolved = false;
    const runtimePromise = createAlayaDaemonRuntime().then((runtime) => {
      activeRuntimes.push(runtime);
      bootResolved = true;
      return runtime;
    });

    try {
      await vi.waitFor(() => {
        expect(bootResolved).toBe(true);
      });

      providerWarmup.reject(new Error("observer boom"));
      await Promise.resolve();
      await Promise.resolve();

      expect(warn).toHaveBeenCalledWith(
        "embedding provider warmup observer failed",
        expect.objectContaining({ error: "observer boom" })
      );
      await expect(runtimePromise).resolves.toBeDefined();
    } finally {
      providerWarmup.reject(new Error("observer boom"));
      await runtimePromise.catch(() => undefined);
    }
  });
});
