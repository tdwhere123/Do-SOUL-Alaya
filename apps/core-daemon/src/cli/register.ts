import { randomUUID } from "node:crypto";
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
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  buildProfileMutationAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths
} from "./config-files.js";
import { createDetachCommandSpec } from "./detach.js";
import { createDoctorCommand, type GardenComputeStatus, type GardenKeychainCheck } from "./doctor.js";
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
import { resolveSecretRef, type ResolvedSecret, type ResolveSecretError } from "../secrets.js";
import {
  parseSecretRefKeychainTarget,
  SECRET_REF_ENV_PREFIX,
  SECRET_REF_FILE_PREFIX,
  secretRefScheme
} from "@do-soul/alaya-protocol";

type GardenSecretRefResolution = ResolvedSecret | ResolveSecretError;

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
    // C2: derive Garden compute provider truth from the same env the daemon
    // bootstrap reads. credential_source distinguishes the dedicated Garden
    // secret_ref from the deprecated embedding-fallback path so operators
    // can see which configuration is actually live.
    getGardenCompute: async () =>
      await resolveGardenComputeStatus(runtime),
    getGraphHealth: async (workspaceId) =>
      await runtime.services.graphHealthService.getStatus(workspaceId),
    reconcileBootstrapPaths: async (workspaceId) =>
      await runtime.services.workspaceService.reconcileBootstrapPaths(workspaceId, {
        causedBy: "user_action"
      }),
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
    getGardenStatus: async () => runtime.services.gardenStatus.getStatus(),
    recallUtilizationService: runtime.services.recallUtilizationService
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

/**
 * C2: derive the Garden compute snapshot the doctor command reports.
 *
 * Reading the saved RuntimeGardenComputeConfig (via configService) gives us
 * provider_kind / model_id / provider_url. The credential_source needs raw
 * env so we can distinguish the dedicated Garden key from the embedding
   * fallback (deprecated for v0.1.1, removed in v0.2). routing_decision
   * stays separate from provider_kind so official_api can degrade to
   * local_heuristics when credentials are missing.
 */
export async function resolveGardenComputeStatus(
  runtime: AlayaDaemonRuntime
): Promise<GardenComputeStatus> {
  const config = await runtime.services.configService.getRuntimeGardenComputeConfig();
  const provenance = await runtime.services.configService.getGardenCredentialProvenance();
  // For keychain refs `resolveSecretRef` triggers a platform subprocess
  // (`security` / `secret-tool` / PowerShell). The doctor pass needs the
  // result for both `routing_decision` and `keychain_check`, so resolve
  // at most once per pass and thread it to both consumers — a locked or
  // missing keychain entry must not pay double cost to be reported.
  const resolved: GardenSecretRefResolution | null =
    config.secret_ref === null ? null : resolveSecretRef(config.secret_ref);
  const credential =
    provenance.kind === "embedding-fallback"
      ? ({ kind: "embedding-fallback" } as const)
      : resolveGardenCredentialSource(config.secret_ref);
  return {
    provider_kind: config.provider_kind,
    model_id: config.model_id,
    provider_url: config.provider_url,
    credential_source: credential,
    routing_decision: deriveGardenRoutingDecision(config, resolved),
    ...keychainCheckField(config.secret_ref, resolved)
  };
}

function deriveGardenRoutingDecision(
  config: Awaited<ReturnType<AlayaDaemonRuntime["services"]["configService"]["getRuntimeGardenComputeConfig"]>>,
  resolved: GardenSecretRefResolution | null
): GardenComputeStatus["routing_decision"] {
  if (config.provider_kind !== "official_api") {
    return config.provider_kind;
  }

  if (resolved === null) {
    return "local_heuristics";
  }

  return "kind" in resolved ? "local_heuristics" : "official_api";
}

function keychainCheckField(
  secretRef: string | null,
  resolved: GardenSecretRefResolution | null
): Pick<GardenComputeStatus, "keychain_check"> {
  if (secretRef === null || !secretRef.startsWith("keychain:")) {
    return {};
  }
  const parsed = parseSecretRefKeychainTarget(secretRef);
  if (parsed === null) {
    return {
      keychain_check: {
        ok: false,
        service: "",
        account: "",
        error_kind: "malformed",
        remediation:
          "Keychain secret_ref must match keychain:<service>:<account> with each segment limited to [A-Za-z0-9._-]+."
      }
    };
  }

  // `resolved` is non-null whenever `secretRef` is non-null because they
  // are derived from the same `config.secret_ref` in the parent pass.
  // The null-fallback below preserves safety if the contract is ever
  // broken (e.g. a future caller forgets to thread the resolution
  // through) without re-spawning the keychain subprocess.
  if (resolved !== null && !("kind" in resolved)) {
    return {
      keychain_check: {
        ok: true,
        service: parsed.service,
        account: parsed.account
      }
    };
  }

  const error: ResolveSecretError =
    resolved === null
      ? { kind: "malformed", ref: secretRef, reason: "keychain secret_ref was not resolved during this doctor pass." }
      : (resolved as ResolveSecretError);

  return {
    keychain_check: {
      ok: false,
      service: parsed.service,
      account: parsed.account,
      error_kind: keychainErrorKind(error),
      remediation: keychainRemediation(error)
    }
  };
}

function keychainErrorKind(
  error: ResolveSecretError
): Extract<GardenKeychainCheck, { readonly ok: false }>["error_kind"] {
  switch (error.kind) {
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
    case "empty":
    case "malformed":
      return error.kind;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
      return "malformed";
  }
}

function keychainRemediation(error: ResolveSecretError): string {
  switch (error.kind) {
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return error.reason;
    case "empty":
      return "The keychain entry exists but its stored secret is empty.";
    case "malformed":
      return error.reason;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
      return "Configured Garden secret_ref is not a keychain reference.";
  }
}

function resolveGardenCredentialSource(
  secretRef: string | null
): GardenComputeStatus["credential_source"] {
  if (secretRef === null || secretRef === "") {
    // No dedicated Garden secret_ref. Embedding fallback only kicks in when
    // the deprecated path was the active source — getRuntimeGardenComputeConfig
    // surfaces that as a non-null secret_ref starting with "env:", "file:",
    // or "keychain:",
    // so a null here means Garden has no key at all.
    return { kind: "none" };
  }
  switch (secretRefScheme(secretRef)) {
    case "env":
      return { kind: "env", name: secretRef.slice(SECRET_REF_ENV_PREFIX.length) };
    case "file":
      return { kind: "file", masked_path: maskPath(secretRef.slice(SECRET_REF_FILE_PREFIX.length)) };
    case "keychain": {
      const parsed = parseSecretRefKeychainTarget(secretRef);
      if (parsed !== null) {
        return { kind: "keychain", service: parsed.service, account: parsed.account };
      }
      return { kind: "none" };
    }
    case null:
      return { kind: "none" };
  }
}

function maskPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return path;
  }
  return `…/${segments[segments.length - 1]}`;
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

      // gate-6-delta B1: the MCP stdio surface is an attached-agent
      // boundary; it must never advertise itself as a human-reviewer
      // surface ("inspector" / "cli"). An attacker controlling launch
      // env who set ALAYA_AGENT_TARGET=cli would otherwise get
      // assertProposalContext's runId-null loosening at
      // mcp-memory-proposal-workflow.ts:568-571 and could accept any
      // pending proposal in the workspace. The other agent-attached
      // surfaces apply equivalent guards at their boundaries
      // (cli/review.ts:378-408 pins "cli", cli/tools.ts:82-90 rejects
      // human-reviewer targets), so per invariants §30 we fix at
      // source by sanitising the env here.
      const resolvedAgentTarget = resolveMcpAgentTarget(ctx.env.ALAYA_AGENT_TARGET, (message) => {
        ctx.stderr.write(`${message}\n`);
      });

      // sessionId is process-stable for an attached MCP stdio session:
      // each attach launches a fresh `alaya mcp stdio` child, so one
      // uuid per process maps 1:1 to one MCP attach session.
      const mcpSessionId = `mcp-session-${randomUUID()}`;
      const mcpRunId = trustedRunId.runId ?? (await runtime.services.runService.ensureAttachedMcpSessionRun({
        workspaceId: workspaceContext.workspaceId,
        sessionId: mcpSessionId,
        agentTarget: resolvedAgentTarget
      })).run_id;
      runtime.startBackgroundServices();
      const server = await runAlayaMcpStdioServer({
        memoryToolHandler: runtime.services.mcpMemoryToolHandler,
        contextProvider: () => ({
          workspaceId: workspaceContext.workspaceId,
          runId: mcpRunId,
          agentTarget: resolvedAgentTarget,
          sessionId: mcpSessionId
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
