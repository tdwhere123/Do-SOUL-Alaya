import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
export {
  applyBenchFastPragmaIfRequested,
  readEmbeddingWarmupSummary
} from "./daemon-support.js";
export type { BenchFastPragmaResult } from "./daemon-support.js";
import { createBenchDaemonOps } from "./daemon-handle-ops.js";
import { initializeBenchDaemon } from "./daemon-startup.js";
import {
  type BenchReviewerCredentials,
  queryEdgeProposalKpiRows,
  queryTokenMetrics,
  requireBenchOpenAiSecretRef,
  resolveBenchOpenAiSecretRef,
  resolveBenchReviewerCredentials,
  restoreEnv
} from "./daemon-support.js";
import { createBenchWorkspaceManager } from "./daemon-workspace-manager.js";

export const BENCH_DAEMON_MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

type ManagedEnvKey = (typeof BENCH_DAEMON_MANAGED_ENV_KEYS)[number];
const DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND: BenchEmbeddingProviderKind = "openai";
let activeBenchDaemonCount = 0;

export async function startBenchDaemon(
  opts: BenchDaemonOptions = {}
): Promise<BenchDaemonHandle> {
  const state = await createBenchDaemonState(opts);
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
  readonly savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>;
  readonly effectiveOpenAiSecretRef: string;
  readonly reviewerCredentials: BenchReviewerCredentials;
  readonly releaseActive: () => void;
  readonly workspaceManager: ReturnType<typeof createBenchWorkspaceManager>;
}

async function createBenchDaemonState(
  opts: BenchDaemonOptions
): Promise<BenchDaemonState> {
  const defaultWorkspaceId = opts.workspaceId ?? "bench-workspace-1";
  const defaultRunId = opts.runId ?? "bench-run-1";
  const activeContext = { workspaceId: defaultWorkspaceId, runId: defaultRunId };
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const embeddingProviderKind =
    opts.embeddingProviderKind ?? DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND;
  const recallWeightOverrides = opts.recallWeightOverrides;
  const dataDir = opts.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));
  const savedEnv = snapshotManagedEnv();
  const effectiveOpenAiSecretRef =
    embeddingMode === "env" && embeddingProviderKind === "openai"
      ? resolveBenchOpenAiSecretRef(savedEnv)
      : "env:OPENAI_API_KEY";
  if (embeddingMode === "env" && embeddingProviderKind === "openai") {
    requireBenchOpenAiSecretRef(effectiveOpenAiSecretRef);
  }
  return {
    defaultWorkspaceId,
    defaultRunId,
    activeContext,
    embeddingMode,
    embeddingProviderKind,
    recallWeightOverrides,
    dataDir,
    savedEnv,
    effectiveOpenAiSecretRef,
    reviewerCredentials: resolveBenchReviewerCredentials({ options: opts, savedEnv }),
    releaseActive: reserveBenchDaemonSlot(),
    workspaceManager: createBenchWorkspaceManager({
      dataDir,
      activeContext,
      knownWorkspaceIds: [defaultWorkspaceId]
    })
  };
}

async function bootBenchDaemon(
  state: BenchDaemonState
): Promise<BenchDaemonHandle> {
  const resources = await initializeBenchDaemon({
    dataDir: state.dataDir,
    defaultWorkspaceId: state.defaultWorkspaceId,
    defaultRunId: state.defaultRunId,
    activeContext: state.activeContext,
    embeddingMode: state.embeddingMode,
    embeddingProviderKind: state.embeddingProviderKind,
    effectiveOpenAiSecretRef: state.effectiveOpenAiSecretRef,
    savedEnv: state.savedEnv,
    reviewerCredentials: state.reviewerCredentials,
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
    savedEnv: state.savedEnv,
    managedEnvKeys: BENCH_DAEMON_MANAGED_ENV_KEYS,
    reviewerCredentials: state.reviewerCredentials,
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
    restoreEnv(BENCH_DAEMON_MANAGED_ENV_KEYS, state.savedEnv);
    state.releaseActive();
  }
}

function snapshotManagedEnv(): Partial<Record<ManagedEnvKey, string | undefined>> {
  const savedEnv: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of BENCH_DAEMON_MANAGED_ENV_KEYS) {
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
