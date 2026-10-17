import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";

const doubles = vi.hoisted(() => ({
  construct: vi.fn(), shutdown: vi.fn(async () => undefined),
  dispatch: vi.fn(async (_argv: readonly string[]) => ({ exitCode: 0 })),
  server: { connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
  cleanupConfig: vi.fn(async () => undefined)
}));
// Exercise real bench state/startup threading, without a daemon, SQLite, worker, or provider.
vi.mock("@do-soul/alaya", () => ({ createAlayaDaemonRuntime: doubles.construct }));
vi.mock("@do-soul/alaya/mcp-server", () => ({ createAlayaMcpServer: () => doubles.server }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {
  async connect() {}
  async close() {}
} }));
vi.mock("@modelcontextprotocol/sdk/inMemory.js", () => ({ InMemoryTransport: {
  createLinkedPair: () => [{}, {}]
} }));
vi.mock("../../../shared/version.js", () => ({ resolveBenchRunnerVersion: () => "fixture-version" }));
vi.mock("../../../harness/daemon/daemon-environment.js", () => ({
  BENCH_DAEMON_MANAGED_ENV_KEYS: [], resolveBenchDaemonManagedEnvKeys: () => []
}));
vi.mock("../../../harness/daemon/daemon-config-directory.js", () => ({
  createBenchDaemonConfigDirectoryLease: () => ({ prepare: async () => undefined, cleanup: doubles.cleanupConfig })
}));
vi.mock("../../../harness/daemon/daemon-support.js", () => ({
  createBenchDaemonLaunchConfig: (input: Record<string, unknown>) => ({ ...input,
    configDir: "/fixture-config", environment: {}, reviewerCredentials: { identity: "fixture", token: "fixture" } }),
  applyBenchDaemonEnvironment: vi.fn(), applyBenchFastPragmaIfRequested: () => ({ applied: false }),
  optimizeBenchDb: vi.fn(), prepareBenchWorkspaceBinding: vi.fn(),
  makeDispatchCli: () => doubles.dispatch, readEmbeddingWarmupSummary: vi.fn(),
  queryEdgeProposalKpiRows: vi.fn(), queryTokenMetrics: vi.fn(), restoreEnv: vi.fn(),
  closeBenchDaemonResources: async ({ runtime }: { runtime: AlayaDaemonRuntime }) => runtime.shutdown()
}));
vi.mock("../../../harness/daemon/runtime/daemon-db-pragmas.js", () => ({ reloadBenchWorkingDatabase: vi.fn() }));
vi.mock("../../../harness/daemon/workspace/daemon-workspace-manager.js", () => ({
  createBenchWorkspaceManager: () => ({ createManagedWorkspaceRoot: async () => "/fixture-workspace",
    cleanupManagedWorkspaceRoots: async () => undefined, createAttachWorkspace: () => vi.fn() })
}));
vi.mock("../../../harness/daemon/handle/daemon-handle-ops.js", () => ({
  createBenchDaemonOps: (input: { activeRuntime: AlayaDaemonRuntime; releaseActive(): void;
    cleanupConfigDirectory(): Promise<void> }) => ({ shutdown: async () => {
      try { await input.activeRuntime.shutdown(); }
      finally { await input.cleanupConfigDirectory(); input.releaseActive(); }
    } })
}));
import { startBenchDaemon } from "../../../harness/daemon.js";

beforeEach(() => {
  doubles.construct.mockResolvedValue({ services: { workspaceService: {}, mcpMemoryToolHandler: {} },
    shutdown: doubles.shutdown });
  doubles.dispatch.mockResolvedValue({ exitCode: 0 });
});
afterEach(() => { vi.clearAllMocks(); });

it.each([undefined, "eager", "omit"] as const)(
  "threads startup probe %s through bench state and startup without inferring it from cached-local execution", async mode => {
    const daemon = await startBenchDaemon({ dataDirRoot: "/fixture-data", embeddingMode: "env",
      embeddingProviderKind: "local_onnx", cachedLocalEmbedding: { cache_root: "/fixture-cache", model_id: "fixture-model" },
      ...(mode === undefined ? {} : { embeddingStartupProbe: mode }) });
    try {
      expect(doubles.construct).toHaveBeenCalledExactlyOnceWith({ embeddingStartupProbe: mode,
        relationProjectionAdmissionMode: undefined, fieldProjectionAdmissionMode: undefined });
      expect(doubles.shutdown).not.toHaveBeenCalled();
    } finally { await daemon.shutdown(); }
    expect(doubles.shutdown).toHaveBeenCalledTimes(1);
  }
);

it("leaves disabled bench startup's probe policy unspecified", async () => {
  const daemon = await startBenchDaemon({ dataDirRoot: "/fixture-data", embeddingMode: "disabled" });
  try {
    expect(doubles.construct).toHaveBeenCalledWith(expect.objectContaining({ embeddingStartupProbe: undefined }));
  } finally { await daemon.shutdown(); }
});

it("closes an omitted-probe runtime after startup fails and releases the bench slot", async () => {
  doubles.dispatch.mockResolvedValueOnce({ exitCode: 1 });
  await expect(startBenchDaemon({ dataDirRoot: "/fixture-data", embeddingMode: "env",
    embeddingProviderKind: "local_onnx", embeddingStartupProbe: "omit" })).rejects.toThrow("alaya install failed");
  expect(doubles.construct).toHaveBeenCalledWith(expect.objectContaining({ embeddingStartupProbe: "omit" }));
  expect(doubles.shutdown).toHaveBeenCalledTimes(1);
  expect(doubles.cleanupConfig).toHaveBeenCalledTimes(1);
  const next = await startBenchDaemon({ dataDirRoot: "/fixture-next", embeddingMode: "disabled" });
  await next.shutdown();
  expect(doubles.shutdown).toHaveBeenCalledTimes(2);
});
