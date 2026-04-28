import { query, type CanUseTool, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeSessionConfig } from "@do-what/protocol";
import type {
  ClaudeSDKClientFactory,
  ClaudeSDKMessage,
  ClaudeSDKSlashCommand,
  ClaudeSDKSlashCommandDispatchOptions,
  ClaudeSDKSlashCommandOptions,
  ClaudeSDKTurnHandle,
  ClaudeSDKTurnOptions
} from "./claude-sdk-client.js";

const MAX_SLASH_COMMAND_OUTPUT_CHARS = 20_000;
const DEFAULT_SLASH_COMMAND_DISCOVERY_TIMEOUT_MS = 2_000;

export interface NodeClaudeSDKClientFactoryOptions {
  readonly slashCommandDiscoveryTimeoutMs?: number;
}

export class NodeClaudeSDKClientFactory implements ClaudeSDKClientFactory {
  public constructor(private readonly factoryOptions: NodeClaudeSDKClientFactoryOptions = {}) {}

  public async startTurn(options: ClaudeSDKTurnOptions): Promise<ClaudeSDKTurnHandle> {
    const startedQuery = query({
      prompt: options.input.prompt,
      options: buildQueryOptions(options)
    });

    return {
      messages: startedQuery,
      cancel: async () => {
        await startedQuery.interrupt();
      }
    };
  }

  public async listSupportedSlashCommands(
    options: ClaudeSDKSlashCommandOptions
  ): Promise<readonly ClaudeSDKSlashCommand[]> {
    const startedQuery = query({
      prompt: "",
      options: buildQueryOptions({
        sessionConfig: options.sessionConfig,
        input: { prompt: "slash command discovery" }
      })
    });

    try {
      const commandsPromise = startedQuery.supportedCommands();
      commandsPromise.catch(() => undefined);
      const commands = await withTimeout(
        commandsPromise,
        this.factoryOptions.slashCommandDiscoveryTimeoutMs ?? DEFAULT_SLASH_COMMAND_DISCOVERY_TIMEOUT_MS,
        "Claude SDK slash command discovery timed out."
      );
      return commands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint
      }));
    } finally {
      startedQuery.close();
    }
  }

  public async dispatchSlashCommand(
    options: ClaudeSDKSlashCommandDispatchOptions
  ): Promise<string> {
    const startedQuery = query({
      prompt: options.command,
      options: buildQueryOptions({
        sessionConfig: options.sessionConfig,
        input: { prompt: options.command }
      })
    });

    let output = "";
    try {
      for await (const message of startedQuery) {
        if (isLocalCommandOutputMessage(message)) {
          output = `${output}${message.content}`.slice(0, MAX_SLASH_COMMAND_OUTPUT_CHARS);
        }
      }
    } finally {
      startedQuery.close();
    }

    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : `Slash command ${options.command} completed without output.`;
  }
}

function isLocalCommandOutputMessage(
  message: ClaudeSDKMessage
): message is ClaudeSDKMessage & { readonly content: string } {
  return (
    message.type === "system" &&
    message.subtype === "local_command_output" &&
    typeof message.content === "string"
  );
}

type RuntimeToolBehaviorProfile = "principal_coding" | "worker_fail_closed";

function buildQueryOptions(options: ClaudeSDKTurnOptions): Options {
  const profile = resolveRuntimeToolBehaviorProfile(options.sessionConfig);

  return {
    continue: false,
    cwd: options.sessionConfig.cwd,
    canUseTool: buildCanUseTool(options.sessionConfig, profile),
    enableFileCheckpointing: true,
    includePartialMessages: true,
    permissionMode: buildPermissionMode(options.sessionConfig, profile),
    persistSession: false,
    sandbox: buildSandboxSettings(options.sessionConfig),
    settings: buildSettings(options.sessionConfig, profile),
    tools: buildToolsSelection(profile)
  };
}

function buildSettings(
  sessionConfig: RuntimeSessionConfig,
  profile: RuntimeToolBehaviorProfile
): NonNullable<Options["settings"]> {
  return {
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [...sessionConfig.allowed_mcp_servers],
    allowedMcpServers: sessionConfig.allowed_mcp_servers.map((serverName) => ({
      serverName
    })),
    permissions: {
      defaultMode: buildPermissionMode(sessionConfig, profile)
    }
  };
}

function buildSandboxSettings(sessionConfig: RuntimeSessionConfig): Options["sandbox"] {
  if (sessionConfig.sandbox_policy === "default") {
    return undefined;
  }

  return {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    filesystem:
      sessionConfig.sandbox_policy === "workspace_write"
        ? { allowWrite: [...sessionConfig.writable_roots] }
        : undefined
  };
}

function buildToolsSelection(profile: RuntimeToolBehaviorProfile): NonNullable<Options["tools"]> {
  if (profile === "principal_coding") {
    return {
      type: "preset",
      preset: "claude_code"
    };
  }

  return [];
}

function buildCanUseTool(
  sessionConfig: RuntimeSessionConfig,
  profile: RuntimeToolBehaviorProfile
): CanUseTool | undefined {
  if (profile === "principal_coding") {
    if (sessionConfig.permission_policy !== "deny") {
      return undefined;
    }

    return async (toolName, _input, options) =>
      denyToolUse(
        toolName,
        options.toolUseID,
        "Runtime permission policy denies all tool execution."
      );
  }

  const reason =
    sessionConfig.permission_policy === "deny"
      ? "Runtime permission policy denies all tool execution."
      : "Runtime tool execution remains fail-closed for the verified Wave 1 baseline.";

  return async (toolName, _input, options) => {
    return denyToolUse(toolName, options.toolUseID, reason);
  };
}

function resolveRuntimeToolBehaviorProfile(sessionConfig: RuntimeSessionConfig): RuntimeToolBehaviorProfile {
  if (sessionConfig.role === "principal") {
    if (sessionConfig.tool_profile === "default" || sessionConfig.tool_profile === "principal_coding") {
      return "principal_coding";
    }

    throw new Error(
      `Unsupported runtime tool profile for principal role: ${sessionConfig.tool_profile}. Valid profiles: default, principal_coding.`
    );
  }

  if (
    sessionConfig.tool_profile === "default" ||
    sessionConfig.tool_profile === "conversation_engine" ||
    sessionConfig.tool_profile === "coding"
  ) {
    return "worker_fail_closed";
  }

  throw new Error(
    `Unsupported runtime tool profile for worker role: ${sessionConfig.tool_profile}. Valid profiles: default, conversation_engine, coding.`
  );
}

function buildPermissionMode(
  sessionConfig: RuntimeSessionConfig,
  profile: RuntimeToolBehaviorProfile
): NonNullable<Options["permissionMode"]> {
  if (profile === "worker_fail_closed") {
    return "dontAsk";
  }

  return sessionConfig.permission_policy === "deny" ? "dontAsk" : "auto";
}

function denyToolUse(toolName: string, toolUseID: string, reason: string) {
  return {
    behavior: "deny" as const,
    message: `${reason} Tool ${toolName} was not executed.`,
    toolUseID
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}
