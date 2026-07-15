/**
 * @internal Exposed via `@do-soul/alaya/cli/register` for the in-process
 * bench harness in `@do-soul/alaya-bench-runner`. Not a stability promise:
 * the export surface, symbol names, and signatures may change without a
 * deprecation period. If you rename or split this module, also update:
 *   - apps/core-daemon/package.json `exports."./cli/register"`
 *   - apps/bench-runner/src/harness/daemon.ts (the only known consumer)
 * @see apps/bench-runner/src/harness/daemon.ts
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { getCurrentSchemaSummary, initDatabase } from "@do-soul/alaya-storage";
import type { ProfileMutationAuditRow, ProfileMutationAuditWriter } from "../attach/index.js";
import type { AlayaDaemonRuntime } from "../index.js";
import { createAttachClaudeCommandSpec, createAttachCodexCommandSpec, createDetachCommandSpec } from "./attach/index.js";
import { runAlayaMcpStdioServer } from "../mcp/mcp-server.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliBridge,
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  buildProfileMutationAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths
} from "./config-files.js";
import { createDoctorCommand } from "./doctor.js";
import { resolveGardenComputeStatus } from "./garden-compute-status.js";
import { readBuildInfo } from "../runtime/build-info.js";
import { createInstallCommand } from "./install.js";
import { createInspectCommand } from "./inspect.js";
import { createUpdateCommand } from "./update.js";
import { defaultRecallPathPlasticityLookupTelemetry } from "../garden/path-plasticity-runtime.js";
import { createOperationCommandSpecs } from "./operations.js";
import { createReviewCommand } from "./review.js";
import { createStatusCommand } from "./status.js";
import { createSourceGroundingDefersCommand } from "./source-grounding-defers/command.js";
import { createToolsCommand } from "./tools.js";
import {
  ensureImplicitLocalWorkspace,
  resolveTrustedCliRunId,
  resolveCliWorkspaceContext
} from "./workspace-context.js";
export { resolveGardenComputeStatus } from "./garden-compute-status.js";

export function registerAlayaCliCommands(
  bridge: AlayaCliBridge,
  runtime: AlayaDaemonRuntime
): void {
  registerPrimaryCommands(bridge, runtime);
  registerAttachCommands(bridge, runtime);
  registerMemoryCommands(bridge, runtime);
  bridge.registerSubcommand(createMcpCommand(runtime));
  registerOperationCommands(bridge);
}

interface AttachArgs {
  readonly target: "codex" | "claude-code";
  readonly yes: boolean;
  readonly dryRun: boolean;
}

function createAttachCommand(runtime: AlayaDaemonRuntime): AlayaSubcommandSpec<AttachArgs> {
  const codex = createAttachCodexCommandSpec({
    auditWriter: createProfileAuditWriter(process.env),
    trustStateRecorder: runtime.services.trustStateRecorder
  });
  const claude = createAttachClaudeCommandSpec({
    auditWriter: createProfileAuditWriter(process.env),
    trustStateRecorder: runtime.services.trustStateRecorder
  });

  return {
    name: "attach",
    description: "Attach Alaya MCP and slash commands to a supported agent.",
    argsSchema: attachArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      const command = args.target === "codex" ? codex : claude;
      return await command.execute({
        ...ctx,
        yes: args.yes,
        dryRun: args.dryRun
      });
    }
  };
}

function attachArgsSchema(): AlayaCliArgsSchema<AttachArgs> {
  return {
    safeParse: safeParseAttachArgs
  };
}

function createMcpCommand(runtime: AlayaDaemonRuntime): AlayaSubcommandSpec<readonly string[]> {
  return {
    name: "mcp",
    description: "Run the Alaya MCP server transport.",
    argsSchema: stringListArgsSchema(),
    requiresDaemonReady: true,
    handler: async (ctx, args) => await executeMcpCommand(ctx, args, runtime)
  };
}

function resolveMcpAgentTarget(
  requestedAgentTarget: string | undefined,
  warn: (message: string) => void
): string {
  if (requestedAgentTarget === undefined || requestedAgentTarget.trim().length === 0) {
    return "mcp";
  }

  if (requestedAgentTarget === "cli" || requestedAgentTarget === "inspector") {
    warn(`Ignoring ALAYA_AGENT_TARGET=${requestedAgentTarget}: MCP stdio cannot impersonate human-reviewer surfaces.`);
    return "mcp";
  }

  if (
    requestedAgentTarget === "codex" ||
    requestedAgentTarget === "claude-code" ||
    requestedAgentTarget === "garden-worker" ||
    requestedAgentTarget === "mcp"
  ) {
    return requestedAgentTarget;
  }

  warn(`Ignoring unsupported ALAYA_AGENT_TARGET=${requestedAgentTarget}: MCP stdio supports codex, claude-code, garden-worker, or mcp.`);
  return "mcp";
}

function formatMcpStartupError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "unable to start MCP stdio transport";
}

function stringListArgsSchema(): AlayaCliArgsSchema<readonly string[]> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }
      return { success: true, data: input };
    }
  };
}

async function waitForInputClose(stream: NodeJS.ReadableStream): Promise<void> {
  const candidate = stream as NodeJS.ReadableStream & {
    readonly destroyed?: boolean;
    readonly readableEnded?: boolean;
  };
  if (candidate.destroyed === true || candidate.readableEnded === true) {
    return;
  }

  await Promise.race([
    once(stream, "end"),
    once(stream, "close"),
    once(stream, "error")
  ]).then(() => undefined);
}

function createProfileAuditWriter(env: NodeJS.ProcessEnv): ProfileMutationAuditWriter {
  const paths = resolveAlayaConfigPaths(resolveAlayaConfigDir({ env }));
  const pathsByRow = new WeakMap<ProfileMutationAuditRow, string>();

  return {
    append: async (row) => {
      const auditPath = buildProfileMutationAuditPath(paths, row.target, row.direction, row.created_at);
      pathsByRow.set(row, auditPath);
      await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
      await writeFile(auditPath, `${JSON.stringify({ audit_version: 1, ...row })}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    },
    rollback: async (row) => {
      const auditPath = pathsByRow.get(row);
      if (auditPath !== undefined) {
        await unlink(auditPath).catch(() => undefined);
      }
    }
  };
}

function readSchemaSummary(dbPath: string) {
  const summary = getCurrentSchemaSummary(initDatabase({ filename: dbPath }));
  return {
    persistedMaxVersion: summary.persistedMaxVersion,
    knownMaxVersion: summary.knownMaxVersion,
    schemaOk: summary.schemaOk
  };
}

function registerPrimaryCommands(bridge: AlayaCliBridge, runtime: AlayaDaemonRuntime): void {
  bridge.registerSubcommand(createDoctorCommand({
    getBuildInfo: readBuildInfo,
    getToolchainStatus: async () => await runtime.services.environmentStatusService.getStatus(),
    getEmbeddingStatus: async (workspaceId) => await runtime.services.embeddingStatusService.getStatus(workspaceId),
    getMcpHealth: async () => ({
      transport: "ready",
      enrolled_tools: runtime.services.daemonMcpCatalog.listEnrolledToolIds().length
    }),
    getGardenHealth: async () => {
      const gardenStatus = runtime.services.gardenStatus.getStatus();
      return {
        status: gardenStatus.last_pass_at === null ? "degraded" : "healthy",
        last_pass_at: gardenStatus.last_pass_at
      };
    },
    getGardenCredentialProvenance: async () =>
      await runtime.services.configService.getGardenCredentialProvenance(),
    getRuntimeWiring: () => ({
      request_token_source: runtime.requestProtection.tokenSource ?? "ephemeral"
    }),
    getGardenCompute: async () => await resolveGardenComputeStatus(runtime),
    getGraphHealth: async (workspaceId) =>
      await runtime.services.graphHealthService.getStatus(workspaceId),
    reconcileBootstrapPaths: async (workspaceId) =>
      await runtime.services.workspaceService.reconcileBootstrapPaths(workspaceId, {
        causedBy: "user_action"
      }),
    getPathPlasticityLookupTelemetry: () => defaultRecallPathPlasticityLookupTelemetry.snapshot(),
    getSchemaSummary: async (dbPath) => readSchemaSummary(dbPath)
  }));
  bridge.registerSubcommand(createStatusCommand({
    trustStateSummaryProvider: async (agentTarget) => await runtime.services.trustStateRecorder.summarize(agentTarget),
    getGardenStatus: async () => runtime.services.gardenStatus.getStatus(),
    getSourceGroundingDeferStats: () => runtime.services.signalService.getSourceGroundingDeferStats(),
    recallUtilizationService: runtime.services.recallUtilizationService
  }));
  bridge.registerSubcommand(createInstallCommand());
  bridge.registerSubcommand(createInspectCommand({
    getRequestToken: () => runtime.requestProtection.requestToken,
    startDaemonServer: async (options) => await runtime.startHttpServer(options)
  }));
  bridge.registerSubcommand(createUpdateCommand());
}

function registerAttachCommands(bridge: AlayaCliBridge, runtime: AlayaDaemonRuntime): void {
  bridge.registerSubcommand(createAttachCommand(runtime));
  bridge.registerSubcommand(createDetachCommandSpec({
    auditWriter: createProfileAuditWriter(process.env)
  }));
}

function registerMemoryCommands(bridge: AlayaCliBridge, runtime: AlayaDaemonRuntime): void {
  bridge.registerSubcommand(createSourceGroundingDefersCommand({
    signalService: runtime.services.signalService
  }));
  bridge.registerSubcommand(createToolsCommand({
    handler: runtime.services.mcpMemoryToolHandler,
    ensureLocalWorkspace: runtime.services.workspaceService,
    runService: runtime.services.runService
  }));
  bridge.registerSubcommand(createReviewCommand({
    handler: runtime.services.mcpMemoryToolHandler,
    ensureLocalWorkspace: runtime.services.workspaceService,
    runService: runtime.services.runService
  }));
}

function registerOperationCommands(bridge: AlayaCliBridge): void {
  for (const command of createOperationCommandSpecs()) {
    bridge.registerSubcommand(command);
  }
}

function safeParseAttachArgs(input: unknown):
  | { readonly success: true; readonly data: AttachArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
  if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "Expected a string argument list." }] }
    };
  }
  return parseAttachArgs(input);
}

function parseAttachArgs(
  input: readonly string[]
):
  | { readonly success: true; readonly data: AttachArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
  let yes = false;
  let dryRun = false;
  const positionals: string[] = [];
  for (const token of input) {
    if (token === "--yes") {
      yes = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token.startsWith("--")) {
      return attachArgsError([], `Unknown attach option: ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    return attachArgsError([], "Usage: attach codex|claude-code [--yes] [--dry-run]");
  }
  const target = positionals[0] === "claude" ? "claude-code" : positionals[0];
  if (target !== "codex" && target !== "claude-code") {
    return attachArgsError([0], "Unsupported attach target.");
  }
  return { success: true, data: { target, yes, dryRun } };
}

function attachArgsError(path: readonly number[], message: string): {
  readonly success: false;
  readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] };
} {
  return {
    success: false,
    error: { issues: [{ path, message }] }
  };
}

async function executeMcpCommand(
  ctx: Parameters<AlayaSubcommandSpec<readonly string[]>["handler"]>[0],
  args: readonly string[],
  runtime: AlayaDaemonRuntime
): Promise<{ readonly exitCode: number }> {
  if (args.length !== 1 || args[0] !== "stdio") {
    ctx.stderr.write("Usage: mcp stdio\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  const workspaceContext = resolveCliWorkspaceContext(ctx);
  await ensureImplicitLocalWorkspace(workspaceContext, runtime.services.workspaceService);
  const trustedRunId = await resolveTrustedCliRunId({
    runId: ctx.env.ALAYA_RUN_ID,
    workspaceId: workspaceContext.workspaceId,
    runService: runtime.services.runService,
    sourceLabel: "ALAYA_RUN_ID"
  });
  if (!trustedRunId.ok) {
    ctx.stderr.write(`${trustedRunId.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  let server: Awaited<ReturnType<typeof runAlayaMcpStdioServer>>;
  try {
    server = await startMcpStdioSession(ctx, runtime, workspaceContext, trustedRunId.runId);
  } catch (error) {
    ctx.stderr.write(`MCP stdio startup failed: ${formatMcpStartupError(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.SOFTWARE };
  }
  try {
    await waitForInputClose(ctx.stdin);
  } finally {
    await server.close();
  }
  return { exitCode: ALAYA_SYSEXITS.OK };
}

async function startMcpStdioSession(
  ctx: Parameters<AlayaSubcommandSpec<readonly string[]>["handler"]>[0],
  runtime: AlayaDaemonRuntime,
  workspaceContext: ReturnType<typeof resolveCliWorkspaceContext>,
  trustedRunId: string | null
): Promise<Awaited<ReturnType<typeof runAlayaMcpStdioServer>>> {
  const resolvedAgentTarget = resolveMcpAgentTarget(ctx.env.ALAYA_AGENT_TARGET, (message) => {
    ctx.stderr.write(`${message}\n`);
  });
  const mcpSessionId = `mcp-session-${randomUUID()}`;
  const mcpRunId = trustedRunId ?? (await runtime.services.runService.ensureAttachedMcpSessionRun({
    workspaceId: workspaceContext.workspaceId,
    sessionId: mcpSessionId,
    agentTarget: resolvedAgentTarget
  })).run_id;
  const server = await runAlayaMcpStdioServer({
    memoryToolHandler: runtime.services.mcpMemoryToolHandler,
    contextProvider: () => ({
      workspaceId: workspaceContext.workspaceId,
      runId: mcpRunId,
      agentTarget: resolvedAgentTarget,
      sessionId: mcpSessionId
    }),
    warn: (message, meta) => {
      ctx.stderr.write(`${message}: ${JSON.stringify(meta)}\n`);
    },
    stdin: ctx.stdin as unknown as Readable,
    stdout: ctx.stdout as unknown as Writable
  });
  runtime.startBackgroundServices();
  return server;
}
