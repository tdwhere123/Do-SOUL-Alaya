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

  it("skips writing unchanged conversation tool specs during daemon bootstrap", async () => {
    const builtinSpecs = getBuiltinConversationToolSpecs();
    hoisted.toolSpecService.findById.mockImplementation(async (toolId: string) => {
      const spec = builtinSpecs.find((candidate) => candidate.tool_id === toolId);
      if (spec === undefined) {
        throw new Error(`missing builtin fixture ${toolId}`);
      }
      return spec;
    });

    await bootDaemonRuntime();

    expect(hoisted.toolSpecService.update).not.toHaveBeenCalled();
    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
  });

  it("rethrows non-NOT_FOUND errors from conversation tool spec sync without falling through", async () => {
    hoisted.toolSpecService.findById.mockRejectedValueOnce(new Error("storage offline"));

    await expect(bootDaemonRuntime()).rejects.toThrow("storage offline");

    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
    expect(hoisted.toolSpecService.update).not.toHaveBeenCalled();
  });

  it("does not fall back to register when update fails after the spec already exists", async () => {
    const { CoreError } = await import("@do-soul/alaya-core");
    hoisted.toolSpecService.findById.mockResolvedValueOnce({
      tool_id: "tools.read_file",
      category: "read",
      description: "Existing spec",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    });
    hoisted.toolSpecService.update.mockRejectedValueOnce(
      new CoreError("NOT_FOUND", "Tool spec disappeared before update")
    );

    await expect(bootDaemonRuntime()).rejects.toThrow("Tool spec disappeared before update");

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
  });

  it("starts CJK warmups without blocking daemon bootstrap", async () => {
    await expectBootstrapDoesNotWaitForCjkWarmups();
  });

  it("warns when CJK segmentation warmups resolve unavailable", async () => {
    const { startCjkSegmentationWarmup } = await import("../../index.js");
    const warn = vi.fn();

    hoisted.coreWarmCjkSegmentation.mockResolvedValueOnce(false);
    hoisted.storageWarmCjkSegmentation.mockResolvedValueOnce(false);
    startCjkSegmentationWarmup({ warn });

    await waitUntil(() => warn.mock.calls.length === 1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("CJK segmentation warmup unavailable"),
      expect.objectContaining({
        code: "ALAYA_CJK_SEGMENTATION_WARMUP_FAILED",
        core_ready: false,
        storage_ready: false
      })
    );
  });

  it("constructs ingest reconciliation by default with the rule-only zero-cloud decision port", async () => {
    // No garden secret + no reconciliation env var -> reconciliation is
    // DEFAULT-ON on the rule-only basis: the cloud garden-LLM is absent so
    // the wired decision port is the rule-only one (zero cloud), and dedup
    // runs out of the box.
    delete process.env.ALAYA_INGEST_RECONCILIATION_ENABLED;
    delete process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF;
    delete process.env.ALAYA_GARDEN_OPENAI_SECRET_REF;

    await bootDaemonRuntime();

    const core = (await import("@do-soul/alaya-core")) as Record<string, any>;
    expect(core.ReconciliationService).toHaveBeenCalledTimes(1);
    // The wired LLM-decision port is the rule-only one (no cloud configured).
    expect(core.createRuleOnlyReconciliationDecisionPort).toHaveBeenCalledTimes(1);
    const ruleOnlyPort = core.createRuleOnlyReconciliationDecisionPort.mock.results[0]?.value;
    expect(core.ReconciliationService.mock.calls[0]?.[0]).toMatchObject({
      llmDecision: ruleOnlyPort
    });
  });

  it("keeps reconciliation ON for a non-disable value: ALAYA_INGEST_RECONCILIATION_ENABLED=1 still constructs it", async () => {
    // The env var is a DISABLE switch (only "0"/"false" turn it off, see
    // index.ts ingestReconciliationEnabled). Anything else must leave the
    // default-ON behavior intact, so an explicit positive value must NOT be
    // misread as a disable.
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED = "1";

    await bootDaemonRuntime();

    const core = (await import("@do-soul/alaya-core")) as Record<string, any>;
    expect(core.ReconciliationService).toHaveBeenCalledTimes(1);
  });

  it("leaves an operator off-switch: ALAYA_INGEST_RECONCILIATION_ENABLED=0 skips reconciliation construction", async () => {
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED = "0";

    await bootDaemonRuntime();

    const core = (await import("@do-soul/alaya-core")) as Record<string, any>;
    expect(core.ReconciliationService).not.toHaveBeenCalled();
    expect(core.createRuleOnlyReconciliationDecisionPort).not.toHaveBeenCalled();
  });

  it("leaves an operator off-switch: ALAYA_INGEST_RECONCILIATION_ENABLED=false skips reconciliation construction", async () => {
    // The second documented disable token alongside "0" (index.ts checks
    // raw !== "0" && raw !== "false"). Asserting it explicitly pins both
    // off-switch spellings so a future single-token parse regresses loudly.
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED = "false";

    await bootDaemonRuntime();

    const core = (await import("@do-soul/alaya-core")) as Record<string, any>;
    expect(core.ReconciliationService).not.toHaveBeenCalled();
    expect(core.createRuleOnlyReconciliationDecisionPort).not.toHaveBeenCalled();
  });

  it("marks principal coding unavailable when a required sandbox tool is missing", async () => {
    const appModule = await import("../../runtime/app.js");

    await bootDaemonRuntime();

    expect(hoisted.createEnvironmentStatusService).toHaveBeenCalledWith(
      expect.objectContaining({
        toolNames: ["git", "node", "pnpm", "rg", "claude", "bwrap", "socat"]
      })
    );
    expect(vi.mocked(appModule.createApp)).toHaveBeenCalledWith(
      expect.objectContaining({
        principalCodingEngineAvailable: false
      }),
      // createApp receives lifecycle state so shutdown can drain in-flight
      // requests before closing.
      expect.objectContaining({
        drainState: expect.objectContaining({ isDraining: false }),
        inFlight: expect.objectContaining({ count: 0 })
      })
    );
  });

  it("does not mount e2e trigger routes in production even when the opt-in env is set", async () => {
    const appModule = await import("../../runtime/app.js");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousE2eOptIn = process.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS;

    try {
      process.env.NODE_ENV = "production";
      process.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS = "1";

      await bootDaemonRuntime();

      const lastCreateAppCall = vi.mocked(appModule.createApp).mock.calls.at(-1);
      expect(lastCreateAppCall?.[0]).toEqual(
        expect.objectContaining({
          routes: expect.not.objectContaining({
            e2eEventTriggers: expect.anything()
          })
        })
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousE2eOptIn === undefined) {
        delete process.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS;
      } else {
        process.env.ALAYA_ENABLE_E2E_EVENT_TRIGGERS = previousE2eOptIn;
      }
    }
  });

  it("keeps one unhandledRejection listener across fatal shutdown and later reboot", async () => {
    const originalExitCode = process.exitCode;
    const unhandledRejectionListenersBefore = process.listeners("unhandledRejection").length;

    try {
      await bootStartedDaemonRuntime();
      const unhandledRejectionListenersAfterFirstBoot =
        process.listeners("unhandledRejection").length;
      expect(unhandledRejectionListenersAfterFirstBoot).toBeGreaterThanOrEqual(
        unhandledRejectionListenersBefore
      );

      let serverCloseCallsBeforeFatal = hoisted.serverClose.mock.calls.length;
      process.emit("unhandledRejection", new Error("first fatal async boundary"), Promise.resolve());

      await vi.waitFor(() => {
        expect(hoisted.serverClose.mock.calls.length).toBeGreaterThan(
          serverCloseCallsBeforeFatal
        );
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;

      await bootStartedDaemonRuntime();
      expect(process.listeners("unhandledRejection")).toHaveLength(
        unhandledRejectionListenersAfterFirstBoot
      );

      serverCloseCallsBeforeFatal = hoisted.serverClose.mock.calls.length;
      process.emit("unhandledRejection", new Error("second fatal async boundary"), Promise.resolve());

      await vi.waitFor(() => {
        expect(hoisted.serverClose.mock.calls.length).toBeGreaterThan(
          serverCloseCallsBeforeFatal
        );
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
