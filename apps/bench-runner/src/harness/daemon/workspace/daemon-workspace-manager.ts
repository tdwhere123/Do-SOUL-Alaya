import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import {
  seedBenchRunOnly,
  seedBenchWorkspaceIfAbsent
} from "../daemon-support.js";
import type {
  BenchDaemonHandle,
  BenchTokenMetrics,
  BenchWorkspaceHandle
} from "../daemon-types.js";

type ActiveBenchContext = { workspaceId: string; runId: string };
type WorkspaceIdentity = { workspaceId: string; runId: string };

interface BenchWorkspaceManagerInput {
  readonly dataDir: string;
  readonly activeContext: ActiveBenchContext;
  readonly knownWorkspaceIds: readonly string[];
}

interface BenchWorkspaceBindings {
  readonly recall: BenchDaemonHandle["recall"];
  readonly warmEmbeddingCache: BenchDaemonHandle["warmEmbeddingCache"];
  readonly warmQueryEmbeddingCache: BenchDaemonHandle["warmQueryEmbeddingCache"];
  readonly reportContextUsage: BenchDaemonHandle["reportContextUsage"];
  readonly proposeMemory: BenchDaemonHandle["proposeMemory"];
  readonly proposeMemoryFromSignal: BenchDaemonHandle["proposeMemoryFromSignal"];
  readonly proposeMemoriesFromCompileSignals: BenchDaemonHandle["proposeMemoriesFromCompileSignals"];
  readonly proposeSynthesis: BenchDaemonHandle["proposeSynthesis"];
  readonly accrueSessionCoRecall: BenchDaemonHandle["accrueSessionCoRecall"];
  readonly accrueCoherenceCoRecall: BenchDaemonHandle["accrueCoherenceCoRecall"];
  readonly accrueAnswersWithCoRelevance: BenchDaemonHandle["accrueAnswersWithCoRelevance"];
  readonly queryTokenMetrics: (
    workspaceId: string
  ) => Promise<BenchTokenMetrics>;
  readonly queryEdgeProposalKpiRows: (
    workspaceId: string
  ) => Promise<readonly EdgeProposalKpiEventRow[]>;
}

export function createBenchWorkspaceManager(input: BenchWorkspaceManagerInput) {
  const managedWorkspaceRoots = new Map<string, string>();
  const knownWorkspaces = new Set(input.knownWorkspaceIds);
  return {
    createManagedWorkspaceRoot: async (workspaceId: string) =>
      await createManagedWorkspaceRoot(
        input.dataDir,
        managedWorkspaceRoots,
        workspaceId
      ),
    cleanupManagedWorkspaceRoots: async () =>
      await cleanupManagedWorkspaceRoots(managedWorkspaceRoots),
    createAttachWorkspace: (bindings: BenchWorkspaceBindings) =>
      createAttachWorkspace({
        dataDir: input.dataDir,
        activeContext: input.activeContext,
        knownWorkspaces,
        managedWorkspaceRoots,
        bindings
      })
  };
}

async function createManagedWorkspaceRoot(
  dataDir: string,
  managedWorkspaceRoots: Map<string, string>,
  workspaceId: string
): Promise<string> {
  const workspaceRoot = join(
    dataDir,
    "bench-workspaces",
    encodeURIComponent(workspaceId)
  );
  await mkdir(workspaceRoot, { recursive: true });
  managedWorkspaceRoots.set(workspaceId, workspaceRoot);
  return workspaceRoot;
}

async function cleanupManagedWorkspaceRoot(
  managedWorkspaceRoots: Map<string, string>,
  workspaceId: string
): Promise<void> {
  const workspaceRoot = managedWorkspaceRoots.get(workspaceId);
  if (workspaceRoot === undefined) {
    return;
  }
  managedWorkspaceRoots.delete(workspaceId);
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function cleanupManagedWorkspaceRoots(
  managedWorkspaceRoots: Map<string, string>
): Promise<void> {
  await Promise.all(
    [...managedWorkspaceRoots.keys()].map(
      async (workspaceId) =>
        await cleanupManagedWorkspaceRoot(managedWorkspaceRoots, workspaceId)
    )
  );
}

function createAttachWorkspace(input: {
  readonly dataDir: string;
  readonly activeContext: ActiveBenchContext;
  readonly knownWorkspaces: Set<string>;
  readonly managedWorkspaceRoots: Map<string, string>;
  readonly bindings: BenchWorkspaceBindings;
}): BenchDaemonHandle["attachWorkspace"] {
  return async (workspace): Promise<BenchWorkspaceHandle> => {
    const workspaceRoot = await createManagedWorkspaceRoot(
      input.dataDir,
      input.managedWorkspaceRoots,
      workspace.workspaceId
    );
    await seedWorkspaceBinding(
      input.dataDir,
      input.knownWorkspaces,
      workspace,
      workspaceRoot
    );
    const previous = snapshotWorkspaceIdentity(input.activeContext);
    bindActiveContext(input.activeContext, workspace);
    return buildBenchWorkspaceHandle(
      input.activeContext,
      input.managedWorkspaceRoots,
      input.bindings,
      workspace,
      previous
    );
  };
}

async function seedWorkspaceBinding(
  dataDir: string,
  knownWorkspaces: Set<string>,
  workspace: WorkspaceIdentity,
  workspaceRoot: string
): Promise<void> {
  if (!knownWorkspaces.has(workspace.workspaceId)) {
    await seedBenchWorkspaceIfAbsent(
      dataDir,
      workspace.workspaceId,
      workspace.runId,
      workspaceRoot
    );
    knownWorkspaces.add(workspace.workspaceId);
    return;
  }
  await seedBenchRunOnly(dataDir, workspace.workspaceId, workspace.runId);
}

function snapshotWorkspaceIdentity(
  activeContext: ActiveBenchContext
): WorkspaceIdentity {
  return {
    workspaceId: activeContext.workspaceId,
    runId: activeContext.runId
  };
}

function bindActiveContext(
  activeContext: ActiveBenchContext,
  workspace: WorkspaceIdentity
): void {
  activeContext.workspaceId = workspace.workspaceId;
  activeContext.runId = workspace.runId;
}

function buildBenchWorkspaceHandle(
  activeContext: ActiveBenchContext,
  managedWorkspaceRoots: Map<string, string>,
  bindings: BenchWorkspaceBindings,
  workspace: WorkspaceIdentity,
  previous: WorkspaceIdentity
): BenchWorkspaceHandle {
  return {
    workspaceId: workspace.workspaceId,
    runId: workspace.runId,
    recall: bindings.recall,
    warmEmbeddingCache: bindings.warmEmbeddingCache,
    warmQueryEmbeddingCache: bindings.warmQueryEmbeddingCache,
    reportContextUsage: bindings.reportContextUsage,
    proposeMemory: bindings.proposeMemory,
    proposeMemoryFromSignal: bindings.proposeMemoryFromSignal,
    proposeMemoriesFromCompileSignals: bindings.proposeMemoriesFromCompileSignals,
    proposeSynthesis: bindings.proposeSynthesis,
    accrueSessionCoRecall: bindings.accrueSessionCoRecall,
    accrueCoherenceCoRecall: bindings.accrueCoherenceCoRecall,
    accrueAnswersWithCoRelevance: bindings.accrueAnswersWithCoRelevance,
    queryTokenMetrics: async () =>
      await bindings.queryTokenMetrics(workspace.workspaceId),
    queryEdgeProposalKpiRows: async () =>
      await bindings.queryEdgeProposalKpiRows(workspace.workspaceId),
    detach: createDetachWorkspace(
      activeContext,
      managedWorkspaceRoots,
      workspace,
      previous
    )
  };
}

function createDetachWorkspace(
  activeContext: ActiveBenchContext,
  managedWorkspaceRoots: Map<string, string>,
  workspace: WorkspaceIdentity,
  previous: WorkspaceIdentity
): () => Promise<void> {
  let detached = false;
  return async (): Promise<void> => {
    if (detached) {
      return;
    }
    detached = true;
    restorePreviousContextIfCurrent(activeContext, workspace, previous);
    await cleanupManagedWorkspaceRoot(managedWorkspaceRoots, workspace.workspaceId);
  };
}

function restorePreviousContextIfCurrent(
  activeContext: ActiveBenchContext,
  workspace: WorkspaceIdentity,
  previous: WorkspaceIdentity
): void {
  if (
    activeContext.workspaceId !== workspace.workspaceId ||
    activeContext.runId !== workspace.runId
  ) {
    return;
  }
  activeContext.workspaceId = previous.workspaceId;
  activeContext.runId = previous.runId;
}
