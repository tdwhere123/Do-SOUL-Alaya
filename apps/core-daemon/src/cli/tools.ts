import { randomUUID } from "node:crypto";
import {
  listAlayaMemoryTools
} from "../mcp-memory-tool-catalog.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandler
} from "../mcp-memory-tool-handler.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  ensureImplicitLocalWorkspace,
  type EnsureLocalWorkspacePort,
  type RunWorkspaceLookupPort,
  resolveTrustedCliRunId,
  resolveCliWorkspaceContext
} from "./workspace-context.js";

export interface ToolsCommandDependencies {
  readonly handler: McpMemoryToolHandler;
  readonly defaultWorkspaceId?: string;
  readonly defaultRunId?: string | null;
  readonly defaultAgentTarget?: string;
  readonly ensureLocalWorkspace?: EnsureLocalWorkspacePort;
  readonly runService?: RunWorkspaceLookupPort;
}

interface ToolsArgs {
  readonly action: "list" | "call";
  readonly toolName: string | null;
  readonly input: unknown;
  readonly contextOverrides: Readonly<{
    readonly workspaceId: string | null;
    readonly runId: string | null | undefined;
    readonly agentTarget: string | null;
  }>;
}

export function createToolsCommand(deps: ToolsCommandDependencies): AlayaSubcommandSpec<ToolsArgs> {
  return {
    name: "tools",
    description: "List or call Alaya first-party MCP memory tools.",
    argsSchema: toolsArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeToolsCommand(ctx, args, deps)
  };
}

async function executeToolsCommand(
  ctx: AlayaCliContext,
  args: ToolsArgs,
  deps: ToolsCommandDependencies
): Promise<AlayaCliResult> {
  if (args.action === "list") {
    const tools = listAlayaMemoryTools();
    if (ctx.jsonRequested !== true) {
      for (const tool of tools) {
        const mode = tool.annotations.readOnlyHint ? "read-only" : "stateful";
        ctx.stdout.write(`${tool.name}\t${mode}\t${tool.description}\n`);
      }
    }
    return {
      exitCode: ALAYA_SYSEXITS.OK,
      json: { tools }
    };
  }

  if (args.toolName === null) {
    ctx.stderr.write("tools call requires a tool name\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  const callContextResult = await buildCallContext(ctx, args, deps);
  if (!callContextResult.ok) {
    ctx.stderr.write(`${callContextResult.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  const callContext = callContextResult.context;
  if (
    isHumanReviewerOnlyTool(args.toolName) &&
    isHumanReviewerAgentTarget(callContext.agentTarget)
  ) {
    ctx.stderr.write(
      "tools call cannot impersonate human reviewer surfaces; use alaya review for proposal review.\n"
    );
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const result = await deps.handler.call({
    toolName: args.toolName,
    arguments: args.input,
    context: callContext
  });

  if (!result.ok) {
    ctx.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return {
      exitCode: result.error.code === "VALIDATION" || result.error.code === "UNKNOWN_TOOL"
        ? ALAYA_SYSEXITS.DATAERR
        : ALAYA_SYSEXITS.SOFTWARE,
      json: result
    };
  }

  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`${JSON.stringify(result.output)}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
}

function isHumanReviewerOnlyTool(toolName: string): boolean {
  return toolName === "soul.review_memory_proposal" ||
    toolName === "soul.batch_review_edge_proposals";
}

function isHumanReviewerAgentTarget(agentTarget: string): boolean {
  return agentTarget === "cli" || agentTarget === "inspector";
}

function toolsArgsSchema(): AlayaCliArgsSchema<ToolsArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }

      const parsed = parseToolsArgs(input);
      if (!parsed.ok) {
        return {
          success: false,
          error: { issues: [{ path: [], message: parsed.message }] }
        };
      }

      return { success: true, data: parsed.args };
    }
  };
}

function parseToolsArgs(input: readonly string[]):
  | Readonly<{ ok: true; args: ToolsArgs }>
  | Readonly<{ ok: false; message: string }> {
  if (input.length === 0) {
    return { ok: false, message: "Usage: tools list | tools call <tool-name> [json] [--workspace <id>] [--run <id>] [--agent <target>]" };
  }

  const action = input[0];
  const rest = input.slice(1);
  const options = parseContextOptions(rest);
  if (!options.ok) {
    return options;
  }

  if (action === "list") {
    if (options.positionals.length > 0) {
      return { ok: false, message: "tools list does not accept positional arguments." };
    }
    return {
      ok: true,
      args: {
        action: "list",
        toolName: null,
        input: {},
        contextOverrides: options.contextOverrides
      }
    };
  }

  if (action !== "call") {
    return { ok: false, message: "Usage: tools list | tools call <tool-name> [json]" };
  }

  const [toolName, rawJson, ...extra] = options.positionals;
  if (toolName === undefined || toolName.trim().length === 0) {
    return { ok: false, message: "tools call requires a tool name." };
  }
  if (extra.length > 0) {
    return { ok: false, message: "tools call accepts at most one JSON argument." };
  }

  let parsedInput: unknown = {};
  if (rawJson !== undefined) {
    try {
      parsedInput = JSON.parse(rawJson) as unknown;
    } catch {
      return { ok: false, message: "tools call JSON argument is malformed." };
    }
  }

  return {
    ok: true,
    args: {
      action: "call",
      toolName,
      input: parsedInput,
      contextOverrides: options.contextOverrides
    }
  };
}

function parseContextOptions(input: readonly string[]):
  | Readonly<{
      ok: true;
      positionals: readonly string[];
      contextOverrides: ToolsArgs["contextOverrides"];
    }>
  | Readonly<{ ok: false; message: string }> {
  const positionals: string[] = [];
  let workspaceId: string | null = null;
  let runId: string | null | undefined = undefined;
  let agentTarget: string | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--workspace" || token === "--run" || token === "--agent") {
      const value = input[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: `${token} requires a non-empty value.` };
      }
      if (token === "--workspace") workspaceId = value.trim();
      if (token === "--run") runId = value.trim() === "null" ? null : value.trim();
      if (token === "--agent") agentTarget = value.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      return { ok: false, message: `Unknown tools option: ${token}` };
    }
    positionals.push(token);
  }

  return {
    ok: true,
    positionals,
    contextOverrides: { workspaceId, runId, agentTarget }
  };
}

async function buildCallContext(
  ctx: AlayaCliContext,
  args: ToolsArgs,
  deps: ToolsCommandDependencies
): Promise<
  | { readonly ok: true; readonly context: McpMemoryToolCallContext }
  | { readonly ok: false; readonly message: string }
> {
  const workspaceContext = resolveCliWorkspaceContext(
    ctx,
    args.contextOverrides.workspaceId,
    deps.defaultWorkspaceId
  );
  await ensureImplicitLocalWorkspace(workspaceContext, deps.ensureLocalWorkspace);

  const requestedRun = resolveRequestedRunId(ctx, args, deps);
  const trustedRunId = await resolveTrustedCliRunId({
    runId: requestedRun.runId,
    workspaceId: workspaceContext.workspaceId,
    runService: deps.runService,
    sourceLabel: requestedRun.sourceLabel
  });
  if (!trustedRunId.ok) {
    return trustedRunId;
  }

  return {
    ok: true,
    context: {
      workspaceId: workspaceContext.workspaceId,
      runId: trustedRunId.runId,
      agentTarget:
        args.contextOverrides.agentTarget ??
        deps.defaultAgentTarget ??
        ctx.env.ALAYA_AGENT_TARGET ??
        "tools-cli",
      sessionId: `tools-cli-${randomUUID()}`
    }
  };
}

function resolveRequestedRunId(
  ctx: AlayaCliContext,
  args: ToolsArgs,
  deps: ToolsCommandDependencies
): { readonly runId: string | null | undefined; readonly sourceLabel: string } {
  if (args.contextOverrides.runId !== undefined) {
    return { runId: args.contextOverrides.runId, sourceLabel: "--run" };
  }
  if (deps.defaultRunId !== undefined && deps.defaultRunId !== null) {
    return { runId: deps.defaultRunId, sourceLabel: "defaultRunId" };
  }
  return { runId: ctx.env.ALAYA_RUN_ID, sourceLabel: "ALAYA_RUN_ID" };
}
