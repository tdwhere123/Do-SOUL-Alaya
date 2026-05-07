import { once } from "node:events";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { getCurrentSchemaSummary, initDatabase } from "@do-soul/alaya-storage";
import type { AlayaDaemonRuntime } from "../index.js";
import { runAlayaMcpStdioServer } from "../mcp-server.js";
import type { ProfileMutationAuditRow, ProfileMutationAuditWriter } from "../profile-mutation.js";
import { createAttachClaudeCommandSpec } from "./attach-claude.js";
import { createAttachCodexCommandSpec } from "./attach-codex.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliBridge,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  buildProfileMutationAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths
} from "./config-files.js";
import { createDetachCommandSpec } from "./detach.js";
import { createDoctorCommand } from "./doctor.js";
import { createInstallCommand } from "./install.js";
import { createInspectCommand } from "./inspect.js";
import { createUpdateCommand } from "./update.js";
import { defaultRecallPathPlasticityLookupTelemetry } from "../path-plasticity-runtime.js";
import { createOperationCommandSpecs } from "./operations.js";
import { createReviewCommand } from "./review.js";
import { createStatusCommand } from "./status.js";
import { createToolsCommand } from "./tools.js";
import {
  ensureImplicitLocalWorkspace,
  resolveTrustedCliRunId,
  resolveCliWorkspaceContext
} from "./workspace-context.js";

export function registerAlayaCliCommands(
  bridge: AlayaCliBridge,
  runtime: AlayaDaemonRuntime
): void {
  bridge.registerSubcommand(createDoctorCommand({
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
    getPathPlasticityLookupTelemetry: () =>
      defaultRecallPathPlasticityLookupTelemetry.snapshot(),
    // p5-system-review-r3 MR-I11: schema_ok needs the live db. initDatabase
    // is per-filename cached in alaya-storage, so reusing it here returns
    // the connection the runtime already holds; we never close it.
    getSchemaSummary: async (dbPath) => {
      const database = initDatabase({ filename: dbPath });
      const summary = getCurrentSchemaSummary(database);
      return {
        persistedMaxVersion: summary.persistedMaxVersion,
        knownMaxVersion: summary.knownMaxVersion,
        schemaOk: summary.schemaOk
      };
    }
  }));
  bridge.registerSubcommand(createStatusCommand({
    trustStateSummaryProvider: async (agentTarget) => await runtime.services.trustStateRecorder.summarize(agentTarget),
    getGardenStatus: async () => runtime.services.gardenStatus.getStatus()
  }));
  bridge.registerSubcommand(createInstallCommand());
  bridge.registerSubcommand(createInspectCommand({
    startDaemonServer: async (options) => await runtime.startHttpServer(options)
  }));
  bridge.registerSubcommand(createUpdateCommand());
  bridge.registerSubcommand(createAttachCommand(runtime));
  bridge.registerSubcommand(createDetachCommandSpec({
    auditWriter: createProfileAuditWriter(process.env)
  }));
  bridge.registerSubcommand(createToolsCommand({
    handler: runtime.services.mcpMemoryToolHandler,
    ensureLocalWorkspace: runtime.services.workspaceService,
    runService: runtime.services.runService
  }));
  // A1 (HITL daemon backbone) — `alaya review pending|accept|reject`
  // routes through the same MCP handler attached agents use, so the
  // CLI fallback and Codex/Claude attach surfaces share one code path.
  bridge.registerSubcommand(createReviewCommand({
    handler: runtime.services.mcpMemoryToolHandler,
    ensureLocalWorkspace: runtime.services.workspaceService,
    runService: runtime.services.runService
  }));
  bridge.registerSubcommand(createMcpCommand(runtime));
  for (const command of createOperationCommandSpecs()) {
    bridge.registerSubcommand(command);
  }
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
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }

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
          return {
            success: false,
            error: { issues: [{ path: [], message: `Unknown attach option: ${token}` }] }
          };
        }
        positionals.push(token);
      }

      if (positionals.length !== 1) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Usage: attach codex|claude-code [--yes] [--dry-run]" }] }
        };
      }

      const target = positionals[0] === "claude" ? "claude-code" : positionals[0];
      if (target !== "codex" && target !== "claude-code") {
        return {
          success: false,
          error: { issues: [{ path: [0], message: "Unsupported attach target." }] }
        };
      }

      return {
        success: true,
        data: {
          target,
          yes,
          dryRun
        }
      };
    }
  };
}

function createMcpCommand(runtime: AlayaDaemonRuntime): AlayaSubcommandSpec<readonly string[]> {
  return {
    name: "mcp",
    description: "Run the Alaya MCP server transport.",
    argsSchema: stringListArgsSchema(),
    requiresDaemonReady: true,
    handler: async (ctx, args) => {
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
      runtime.startBackgroundServices();

      const server = await runAlayaMcpStdioServer({
        memoryToolHandler: runtime.services.mcpMemoryToolHandler,
        contextProvider: () => ({
          workspaceId: workspaceContext.workspaceId,
          runId: trustedRunId.runId,
          agentTarget: ctx.env.ALAYA_AGENT_TARGET ?? "mcp"
        }),
        stdin: ctx.stdin as unknown as Readable,
        stdout: ctx.stdout as unknown as Writable
      });

      try {
        await waitForInputClose(ctx.stdin);
      } finally {
        await server.close();
      }

      return { exitCode: ALAYA_SYSEXITS.OK };
    }
  };
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
