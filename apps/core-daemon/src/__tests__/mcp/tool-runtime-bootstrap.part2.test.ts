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

  it("reports degraded embedding status when supplement is enabled but the secret env is missing", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-missing-embedding-status-"));
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

    const runtime = await bootDaemonRuntime() as Awaited<ReturnType<typeof bootDaemonRuntime>> & {
      readonly services: {
        readonly embeddingStatusService: {
          getStatus(workspaceId: string): Promise<{
            readonly embedding_enabled: boolean;
            readonly provider_configured: boolean;
            readonly effective_mode: string;
            readonly degraded_reason: string | null;
          }>;
        };
      };
    };

    await expect(runtime.services.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
      embedding_enabled: true,
      provider_configured: false,
      effective_mode: "degraded",
      degraded_reason: "provider_unconfigured"
    });
  });

  it("rejects malformed embedding secret refs during daemon bootstrap", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "alaya-daemon-malformed-embedding-"));
    isolatedConfigDirs.push(configDir);
    await writeFile(
      path.join(configDir, ".env"),
      [
        "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true",
        "ALAYA_OPENAI_SECRET_REF=this-has-no-prefix",
        ""
      ].join("\n"),
      "utf8"
    );
    process.env.ALAYA_CONFIG_DIR = configDir;
    delete process.env.ALAYA_OPENAI_SECRET_REF;

    await expect(bootDaemonRuntime()).rejects.toThrow("ALAYA_OPENAI_SECRET_REF");
  });

  it("ignores a raw OPENAI_API_KEY when the Alaya secret-ref env is absent", async () => {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
    process.env.OPENAI_API_KEY = "sk-legacy-global";

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

  it("waits for trust counter EventLog replay before daemon bootstrap completes", async () => {
    const replayGate = createDeferred<void>();
    let bootSettled = false;
    hoisted.rebuildCountersFromEventLog.mockImplementationOnce(async () => {
      await replayGate.promise;
    });

    const bootPromise = bootDaemonRuntime().then((runtime) => {
      bootSettled = true;
      return runtime;
    });
    await waitUntil(() => hoisted.rebuildCountersFromEventLog.mock.calls.length > 0);

    expect(bootSettled).toBe(false);
    replayGate.resolve();
    await bootPromise;
    expect(hoisted.rebuildCountersFromEventLog).toHaveBeenCalledTimes(1);
  });

  it("fails daemon bootstrap instead of marking trust state ready when counter replay rejects", async () => {
    hoisted.rebuildCountersFromEventLog.mockRejectedValueOnce(new Error("replay failed"));

    await expect(bootDaemonRuntime()).rejects.toThrow("replay failed");

    expect(hoisted.rebuildCountersFromEventLog).toHaveBeenCalledTimes(1);
  });

  it("syncs write_file and exec_shell conversation tool specs during daemon bootstrap", async () => {
    await bootDaemonRuntime();

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.list_directory");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.search_files");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.write_file");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.exec_shell");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.write_file" })
    );
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.exec_shell" })
    );
  });

  it("constructs a canonical alias service and injects it into live claim producers", async () => {
    await bootDaemonRuntime();

    expect(hoisted.canonicalAliasServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        aliasMap: {
          "governance_subject.domain": [
            {
              alias: "用户偏好",
              canonical: "user_preference",
              language: "zh",
              domain: "governance_subject.domain"
            }
          ],
          "governance_subject.qualifier.framework": [
            {
              alias: "类型脚本",
              canonical: "typescript",
              language: "zh",
              domain: "governance_subject.qualifier.framework"
            }
          ]
        },
        eventPublisher: expect.any(Object)
      })
    );
    expect(hoisted.claimServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalAliasService: expect.any(Object),
        eventPublisher: expect.any(Object)
      })
    );
  });

  it("wires the worker-dispatch static alias into the live server hard-constraint allowlist", async () => {
    await bootDaemonRuntime();

    const appDeps = (hoisted.createApp.mock.calls as readonly (readonly unknown[])[])[0]?.[0] as
      | { listServerHardConstraints?: (workspaceId: string) => Promise<readonly { ref: string; content: string }[]> }
      | undefined;
    expect(typeof appDeps?.listServerHardConstraints).toBe("function");

    const constraints = await appDeps?.listServerHardConstraints?.("workspace-1");

    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "constraint://worker-dispatch",
          content: "Never mutate files outside approved workspace roots."
        })
      ])
    );
  });

  it("delegates ContextLens assembly directly on the live conversation seam until manifestation candidates exist", async () => {
    await bootDaemonRuntime();

    const core = (await import("@do-soul/alaya-core")) as Record<string, any>;
    const conversationServiceDeps = core.ConversationService.mock.calls[0]?.[0] as
      | {
          readonly contextLensAssembler?: {
            assemble(params: {
              readonly run: {
                readonly run_id: string;
                readonly workspace_id: string;
                readonly run_mode: string;
                readonly title: string;
              };
              readonly surfaceId: string | null;
              readonly displayName?: string;
              readonly runtimeMode: string;
            }): Promise< unknown>;
          };
        }
      | undefined;
    const wrappedAssembler = conversationServiceDeps?.contextLensAssembler;

    expect(core.ManifestationResolver).not.toHaveBeenCalled();
    expect(wrappedAssembler).toBeDefined();

    const order: string[] = [];
    (hoisted.contextLensAssemble as ReturnType<typeof vi.fn>).mockImplementationOnce(async (params: unknown) => {
      order.push("assemble");
      expect(params).toEqual({
        run: {
          run_id: "run-1",
          workspace_id: "workspace-1",
          run_mode: "chat",
          title: "manifestation test"
        },
        surfaceId: "surface://chat/main",
        displayName: "Manifestation pass",
        runtimeMode: "full"
      });
      return {
        contextLens: null,
        workingProjection: {
          entries: [],
          total_token_estimate: 0
        }
      };
    });

    await wrappedAssembler?.assemble({
      run: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "manifestation test"
      },
      surfaceId: "surface://chat/main",
      displayName: "Manifestation pass",
      runtimeMode: "full"
    });

    expect(order).toEqual(["assemble"]);
  });

  it("registers missing conversation tool specs when ToolSpecService.findById reports NOT_FOUND", async () => {
    const { CoreError } = await import("@do-soul/alaya-core");
    hoisted.toolSpecService.findById.mockRejectedValueOnce(new CoreError("NOT_FOUND", "Tool spec not found"));

    await bootDaemonRuntime();

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.register).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
  });

  it("updates existing conversation tool specs when ToolSpecService.findById succeeds", async () => {
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

    await bootDaemonRuntime();

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
  });
});
