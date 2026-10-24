import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createAlayaDaemonRuntime,
  type AlayaDaemonRuntime,
  type AlayaDaemonRuntimeOptions,
  type EffectiveReconciliationBasis,
  type FieldProjectionAdmissionMode,
  type RelationProjectionAdmissionMode
} from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { resolveBenchRunnerVersion } from "../../shared/version.js";
import {
  applyBenchDaemonEnvironment,
  applyBenchFastPragmaIfRequested,
  closeBenchDaemonResources,
  makeDispatchCli,
  optimizeBenchDb,
  prepareBenchWorkspaceBinding,
  type BenchDaemonLaunchConfig
} from "./daemon-support.js";
import type { BenchDaemonConfigDirectoryLease } from "./daemon-config-directory.js";
import type { BenchDaemonHandle } from "./daemon-types.js";

type ActiveBenchContext = { workspaceId: string; runId: string };

export interface BenchDaemonStartupInput {
  readonly sourceSemanticObservations?: boolean;
  readonly embeddingStartupProbe?: AlayaDaemonRuntimeOptions["embeddingStartupProbe"];
  readonly sourceSemanticInterpretationClock?: string;
  readonly dataDir: string;
  readonly defaultWorkspaceId: string;
  readonly defaultRunId: string;
  readonly activeContext: ActiveBenchContext;
  readonly launch: BenchDaemonLaunchConfig;
  readonly expectedReconciliationBasis?: EffectiveReconciliationBasis;
  readonly relationProjectionAdmissionMode?: RelationProjectionAdmissionMode;
  readonly fieldProjectionAdmissionMode?: FieldProjectionAdmissionMode;
  readonly configDirectory: BenchDaemonConfigDirectoryLease;
  readonly managedEnvKeys: readonly string[];
  readonly createManagedWorkspaceRoot: (workspaceId: string) => Promise<string>;
}

export interface BenchDaemonStartupResources {
  readonly observeSourceSemantics?: BenchDaemonHandle["observeSourceSemantics"];
  readonly runtime: AlayaDaemonRuntime;
  readonly server: ReturnType<typeof createAlayaMcpServer>;
  readonly mcpClient: Client;
  readonly dispatchCli: (
    argv: readonly string[]
  ) => Promise<{ exitCode: number; json?: unknown }>;
}

export async function initializeBenchDaemon(
  input: BenchDaemonStartupInput
): Promise<BenchDaemonStartupResources> {
  applyBenchDaemonEnvironment(input.launch.environment, input.managedEnvKeys);
  await input.configDirectory.prepare();
  const resources = await createBenchRuntimeResources(input);
  try {
    await installBenchProfile(
      resources.dispatchCli,
      input.dataDir,
      input.defaultWorkspaceId,
      input.launch.embeddingMode === "env"
    );
    await seedBenchDefaultWorkspace(input, resources.runtime);
    logBenchPragmaApplication(input.dataDir);
    optimizeBenchDb(input.dataDir);
    return resources;
  } catch (error) {
    await closeBenchDaemonResources(resources);
    throw error;
  }
}

async function createBenchRuntimeResources(input: BenchDaemonStartupInput): Promise<BenchDaemonStartupResources> {
  const { activeContext, expectedReconciliationBasis, relationProjectionAdmissionMode,
    fieldProjectionAdmissionMode, sourceSemanticInterpretationClock, embeddingStartupProbe } = input;
  const options: AlayaDaemonRuntimeOptions = {
    embeddingStartupProbe,
    ...(sourceSemanticInterpretationClock === undefined ? {} : { sourceSemanticInterpretationClock }),
    relationProjectionAdmissionMode,
    fieldProjectionAdmissionMode
  };
  // The private friend owns both construction and registry lookup so source/dist
  // test aliases cannot split them. Ordinary startup keeps its existing entry.
  const observed = input.sourceSemanticObservations === true
    ? await (await import("../../../../core-daemon/dist/runtime/recall/source-semantic-observation.js"))
      .createSourceObservedRuntime(options) : undefined;
  const runtime = observed?.runtime ?? await createAlayaDaemonRuntime(options);
  try {
    assertExpectedReconciliationBasis(runtime, expectedReconciliationBasis);
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
  const sessionId = `bench-session-${Date.now()}`;
  const server = createAlayaMcpServer({
    memoryToolHandler: runtime.services.mcpMemoryToolHandler,
    contextProvider: () => createBenchToolContext(activeContext, sessionId)
  });
  const mcpClient = new Client(
    { name: "alaya-bench-runner", version: resolveBenchRunnerVersion() },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  const observeSourceSemantics = observed?.observeSourceSemantics;
  return {
    runtime,
    ...(observeSourceSemantics === undefined ? {} : { observeSourceSemantics }),
    server,
    mcpClient,
    dispatchCli: makeDispatchCli(runtime)
  };
}

function assertExpectedReconciliationBasis(
  runtime: AlayaDaemonRuntime,
  expected: EffectiveReconciliationBasis | undefined
): void {
  if (expected === undefined) return;
  const status = runtime.services.reconciliationBasisStatus;
  if (!status.enabled) {
    throw new Error(
      `expected reconciliation basis ${expected} but reconciliation is disabled`
    );
  }
  if (status.basis !== expected) {
    throw new Error(
      `expected reconciliation basis ${expected} but daemon selected ${status.basis}`
    );
  }
}

function createBenchToolContext(activeContext: ActiveBenchContext, sessionId: string) {
  return {
    workspaceId: activeContext.workspaceId,
    runId: activeContext.runId,
    agentTarget: "bench-runner",
    sessionId,
    surfaceId: "bench"
  };
}

async function installBenchProfile(
  dispatchCli: BenchDaemonStartupResources["dispatchCli"],
  dataDir: string,
  defaultWorkspaceId: string,
  embeddingEnabled: boolean
): Promise<void> {
  const install = await dispatchCli([
    "install",
    "--non-interactive",
    JSON.stringify({
      db_path: `${dataDir}/alaya.db`,
      embedding_enabled: embeddingEnabled,
      default_workspace: defaultWorkspaceId,
      worktree_enabled: false
    }),
    "--json"
  ]);
  if (install.exitCode !== 0) {
    throw new Error(`alaya install failed with exitCode=${install.exitCode}`);
  }
  const attach = await dispatchCli(["attach", "codex", "--yes", "--json"]);
  if (attach.exitCode !== 0) {
    throw new Error(`alaya attach failed with exitCode=${attach.exitCode}`);
  }
}

async function seedBenchDefaultWorkspace(
  input: BenchDaemonStartupInput,
  runtime: AlayaDaemonRuntime
): Promise<void> {
  const workspaceRoot = await input.createManagedWorkspaceRoot(input.defaultWorkspaceId);
  await prepareBenchWorkspaceBinding({
    dataDir: input.dataDir,
    workspaceId: input.defaultWorkspaceId,
    runId: input.defaultRunId,
    workspaceRoot,
    workspaceService: runtime.services.workspaceService
  });
}

function logBenchPragmaApplication(dataDir: string): void {
  const pragmaResult = applyBenchFastPragmaIfRequested(dataDir);
  if (!pragmaResult.applied) {
    return;
  }
  process.stderr.write(
    `[bench fast-pragma] applied: ${pragmaResult.pragmas.join(", ")}\n`
  );
}
