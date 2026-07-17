import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { resolveBenchRunnerVersion } from "../../shared/version.js";
import {
  applyBenchDaemonEnvironment,
  applyBenchFastPragmaIfRequested,
  closeBenchDaemonResources,
  makeDispatchCli,
  seedBenchWorkspaceAndRun,
  type BenchDaemonLaunchConfig
} from "./daemon-support.js";
import type { BenchDaemonConfigDirectoryLease } from "./daemon-config-directory.js";

type ActiveBenchContext = { workspaceId: string; runId: string };

export interface BenchDaemonStartupInput {
  readonly dataDir: string;
  readonly defaultWorkspaceId: string;
  readonly defaultRunId: string;
  readonly activeContext: ActiveBenchContext;
  readonly launch: BenchDaemonLaunchConfig;
  readonly configDirectory: BenchDaemonConfigDirectoryLease;
  readonly managedEnvKeys: readonly string[];
  readonly createManagedWorkspaceRoot: (workspaceId: string) => Promise<string>;
}

export interface BenchDaemonStartupResources {
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
  const resources = await createBenchRuntimeResources(input.activeContext);
  try {
    await installBenchProfile(
      resources.dispatchCli,
      input.dataDir,
      input.defaultWorkspaceId,
      input.launch.embeddingMode === "env"
    );
    await seedBenchDefaultWorkspace(input);
    logBenchPragmaApplication(input.dataDir);
    return resources;
  } catch (error) {
    await closeBenchDaemonResources(resources);
    throw error;
  }
}

async function createBenchRuntimeResources(
  activeContext: ActiveBenchContext
): Promise<BenchDaemonStartupResources> {
  const runtime = await createAlayaDaemonRuntime();
  const server = createAlayaMcpServer({
    memoryToolHandler: runtime.services.mcpMemoryToolHandler,
    contextProvider: () => createBenchToolContext(activeContext)
  });
  const mcpClient = new Client(
    { name: "alaya-bench-runner", version: resolveBenchRunnerVersion() },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return {
    runtime,
    server,
    mcpClient,
    dispatchCli: makeDispatchCli(runtime)
  };
}

function createBenchToolContext(activeContext: ActiveBenchContext) {
  return {
    workspaceId: activeContext.workspaceId,
    runId: activeContext.runId,
    agentTarget: "bench-runner",
    sessionId: `bench-session-${Date.now()}`,
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
  input: BenchDaemonStartupInput
): Promise<void> {
  await seedBenchWorkspaceAndRun(
    input.dataDir,
    input.defaultWorkspaceId,
    input.defaultRunId,
    await input.createManagedWorkspaceRoot(input.defaultWorkspaceId)
  );
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
