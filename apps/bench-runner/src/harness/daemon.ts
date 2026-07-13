import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND,
  type BenchDaemonHandle,
  type BenchDaemonOptions,
  type BenchEmbeddingProviderKind
} from "./daemon-types.js";
export { rotatingSeedObjectKind, type SeedObjectKind, BENCH_SEED_ROTATION } from "./seed-rotation.js";
export {
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError,
  type BenchContextUsageObject,
  type BenchDaemonHandle,
  type BenchDaemonOptions,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchEdgeFormationMember,
  type BenchEmbeddingWarmupOptions,
  type BenchEmbeddingWarmupSummary,
  type BenchQueryEmbeddingWarmupSummary,
  type BenchRecallOptions,
  type BenchReportContextUsageInput,
  type BenchSignalSeedInput,
  type BenchSynthesisSeedInput,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle,
  type CompileSeedBatchResult,
  type CompileSeedDropReason,
  type CompileSeedSignalDrop,
  type DrainEmbeddingWarmupPassesInput,
  type DrainEmbeddingWarmupPassesResult,
  type SeededMemoryResult,
  type SeededSynthesisResult
} from "./daemon-types.js";
export { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "./daemon-types.js";
export {
  applyBenchFastPragmaIfRequested,
  readEmbeddingWarmupSummary
} from "./daemon-support.js";
export type { BenchFastPragmaResult } from "./daemon-support.js";
export { BENCH_DAEMON_MANAGED_ENV_KEYS } from "./daemon-environment.js";
import { createBenchDaemonOps } from "./daemon-handle-ops.js";
import { initializeBenchDaemon } from "./daemon-startup.js";
import {
  createBenchDaemonConfigDirectoryLease,
  type BenchDaemonConfigDirectoryLease
} from "./daemon-config-directory.js";
import {
  createBenchDaemonLaunchConfig,
  queryEdgeProposalKpiRows,
  queryTokenMetrics,
  restoreEnv
} from "./daemon-support.js";
import {
  resolveBenchDaemonManagedEnvKeys,
  type BenchDaemonLaunchConfig
} from "./daemon-environment.js";
import { createBenchWorkspaceManager } from "./daemon-workspace-manager.js";

let activeBenchDaemonCount = 0;

export async function startBenchDaemon(
  opts: BenchDaemonOptions = {},
  preparedLaunch?: BenchDaemonLaunchConfig
): Promise<BenchDaemonHandle> {
  const state = await createBenchDaemonState(opts, preparedLaunch);
  try {
    return await bootBenchDaemon(state);
  } catch (err) {
    await cleanupFailedBenchDaemonStart(state);
    throw err;
  }
}

interface BenchDaemonState {
  readonly defaultWorkspaceId: string;
  readonly defaultRunId: string;
  readonly activeContext: { workspaceId: string; runId: string };
  readonly embeddingMode: NonNullable<BenchDaemonOptions["embeddingMode"]>;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly recallWeightOverrides: BenchDaemonOptions["recallWeightOverrides"];
  readonly dataDir: string;
  readonly savedEnv: Partial<Record<string, string | undefined>>;
  readonly managedEnvKeys: readonly string[];
  readonly launch: BenchDaemonLaunchConfig;
  readonly configDirectory: BenchDaemonConfigDirectoryLease;
  readonly releaseActive: () => void;
  readonly workspaceManager: ReturnType<typeof createBenchWorkspaceManager>;
}

async function createBenchDaemonState(
  opts: BenchDaemonOptions,
  preparedLaunch: BenchDaemonLaunchConfig | undefined
): Promise<BenchDaemonState> {
  const defaultWorkspaceId = opts.workspaceId ?? "bench-workspace-1";
  const defaultRunId = opts.runId ?? "bench-run-1";
  const activeContext = { workspaceId: defaultWorkspaceId, runId: defaultRunId };
  const recallWeightOverrides = opts.recallWeightOverrides;
  const dataDir = opts.dataDirRoot ??
    preparedLaunch?.dataDir ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));
  const embeddingMode = opts.embeddingMode ?? preparedLaunch?.embeddingMode ?? "disabled";
  const embeddingProviderKind = opts.embeddingProviderKind ??
    preparedLaunch?.embeddingProviderKind ?? DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND;
  const launch = preparedLaunch ?? createBenchDaemonLaunchConfig({
    dataDir,
    embeddingMode,
    embeddingProviderKind,
    reviewerIdentity: opts.reviewerIdentity,
    reviewerToken: opts.reviewerToken
  });
  assertPreparedLaunchMatches(launch, { dataDir, embeddingMode, embeddingProviderKind });
  const configDirectory = createBenchDaemonConfigDirectoryLease(launch.configDir);
  const managedEnvKeys = resolveBenchDaemonManagedEnvKeys(launch.environment, process.env);
  const savedEnv = snapshotManagedEnv(managedEnvKeys);
  return {
    defaultWorkspaceId,
    defaultRunId,
    activeContext,
    embeddingMode,
    embeddingProviderKind,
    recallWeightOverrides,
    dataDir,
    savedEnv,
    managedEnvKeys,
    launch,
    configDirectory,
    releaseActive: reserveBenchDaemonSlot(),
    workspaceManager: createBenchWorkspaceManager({
      dataDir,
      activeContext,
      knownWorkspaceIds: [defaultWorkspaceId]
    })
  };
}

function assertPreparedLaunchMatches(
  launch: BenchDaemonLaunchConfig,
  expected: Pick<BenchDaemonLaunchConfig, "dataDir" | "embeddingMode" | "embeddingProviderKind">
): void {
  if (launch.dataDir !== expected.dataDir || launch.embeddingMode !== expected.embeddingMode ||
      launch.embeddingProviderKind !== expected.embeddingProviderKind) {
    throw new Error("prepared bench daemon launch does not match requested options");
  }
}

async function bootBenchDaemon(
  state: BenchDaemonState
): Promise<BenchDaemonHandle> {
  const resources = await initializeBenchDaemon({
    dataDir: state.dataDir,
    defaultWorkspaceId: state.defaultWorkspaceId,
    defaultRunId: state.defaultRunId,
    activeContext: state.activeContext,
    launch: state.launch,
    configDirectory: state.configDirectory,
    managedEnvKeys: state.managedEnvKeys,
    createManagedWorkspaceRoot: state.workspaceManager.createManagedWorkspaceRoot
  });
  const daemonOps = createBenchDaemonOps({
    dataDir: state.dataDir,
    activeContext: state.activeContext,
    activeRuntime: resources.runtime,
    activeServer: resources.server,
    activeMcpClient: resources.mcpClient,
    recallWeightOverrides: state.recallWeightOverrides,
    embeddingMode: state.embeddingMode,
    embeddingProviderKind: state.embeddingProviderKind,
    effectiveEnv: state.launch.environment,
    savedEnv: state.savedEnv,
    managedEnvKeys: state.managedEnvKeys,
    reviewerCredentials: state.launch.reviewerCredentials,
    cleanupConfigDirectory: state.configDirectory.cleanup,
    releaseActive: state.releaseActive,
    cleanupManagedWorkspaceRoots: state.workspaceManager.cleanupManagedWorkspaceRoots
  });
  const attachWorkspace = state.workspaceManager.createAttachWorkspace({
    ...daemonOps,
    queryTokenMetrics: async (workspaceId: string) =>
      await queryTokenMetrics(state.dataDir, workspaceId),
    queryEdgeProposalKpiRows: async (workspaceId: string) =>
      await queryEdgeProposalKpiRows(state.dataDir, workspaceId)
  });
  return buildBenchDaemonHandle(state, resources, daemonOps, attachWorkspace);
}

function buildBenchDaemonHandle(
  state: BenchDaemonState,
  resources: Awaited<ReturnType<typeof initializeBenchDaemon>>,
  daemonOps: ReturnType<typeof createBenchDaemonOps>,
  attachWorkspace: BenchDaemonHandle["attachWorkspace"]
): BenchDaemonHandle {
  return {
    runtime: resources.runtime,
    mcpClient: resources.mcpClient,
    get workspaceId() {
      return state.activeContext.workspaceId;
    },
    get runId() {
      return state.activeContext.runId;
    },
    dataDir: state.dataDir,
    dispatchCli: resources.dispatchCli,
    ...daemonOps,
    queryTokenMetrics: async () =>
      await queryTokenMetrics(state.dataDir, state.activeContext.workspaceId),
    queryEdgeProposalKpiRows: async () =>
      await queryEdgeProposalKpiRows(state.dataDir, state.activeContext.workspaceId),
    attachWorkspace
  };
}

async function cleanupFailedBenchDaemonStart(
  state: BenchDaemonState
): Promise<void> {
  try {
    await state.workspaceManager.cleanupManagedWorkspaceRoots();
  } finally {
    try {
      await state.configDirectory.cleanup();
    } finally {
      restoreEnv(state.managedEnvKeys, state.savedEnv);
      state.releaseActive();
    }
  }
}

function snapshotManagedEnv(
  managedEnvKeys: readonly string[]
): Partial<Record<string, string | undefined>> {
  const savedEnv: Partial<Record<string, string | undefined>> = {};
  for (const key of managedEnvKeys) {
    savedEnv[key] = process.env[key];
  }
  return savedEnv;
}

function reserveBenchDaemonSlot(): () => void {
  if (activeBenchDaemonCount > 0) {
    throw new Error(
      "startBenchDaemon supports only one active daemon per process; use process-level shards for LongMemEval parallelism"
    );
  }
  activeBenchDaemonCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeBenchDaemonCount = Math.max(0, activeBenchDaemonCount - 1);
  };
}
