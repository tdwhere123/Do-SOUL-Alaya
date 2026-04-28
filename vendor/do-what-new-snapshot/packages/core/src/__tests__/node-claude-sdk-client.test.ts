import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSessionConfigSchema } from "@do-what/protocol";
import { NodeClaudeSDKClientFactory } from "../runtime-adapters/node-claude-sdk-client.js";

type OfficialSDKFilesPersistedEvent = import("@anthropic-ai/claude-agent-sdk").SDKFilesPersistedEvent;
type OfficialSDKSystemMessage = import("@anthropic-ai/claude-agent-sdk").SDKSystemMessage;
type OfficialSDKSlashCommand = import("@anthropic-ai/claude-agent-sdk").SlashCommand;
type OfficialSDKLocalCommandOutputMessage = {
  readonly type: "system";
  readonly subtype: "local_command_output";
  readonly content: string;
};
type QueryHandle = AsyncIterable<OfficialSDKSystemMessage | OfficialSDKFilesPersistedEvent | OfficialSDKLocalCommandOutputMessage> & {
  interrupt(): Promise<void>;
  supportedCommands(): Promise<OfficialSDKSlashCommand[]>;
  close(): void;
};

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn()
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock
}));

const VALID_SESSION_CONFIG = RuntimeSessionConfigSchema.parse({
  role: "worker",
  workspace_id: "workspace-1",
  run_id: "run-1",
  cwd: "/workspace/project",
  writable_roots: ["/workspace/project", "/workspace/cache"],
  tool_profile: "default",
  allowed_mcp_servers: ["filesystem"],
  sandbox_policy: "workspace_write",
  permission_policy: "ask",
  network_policy: "restricted"
});

const PRINCIPAL_CODING_SESSION_CONFIG = RuntimeSessionConfigSchema.parse({
  role: "principal",
  workspace_id: "workspace-1",
  run_id: "run-1",
  cwd: "/workspace/project",
  writable_roots: ["/workspace/project", "/workspace/cache"],
  tool_profile: "principal_coding",
  allowed_mcp_servers: ["filesystem"],
  sandbox_policy: "workspace_write",
  permission_policy: "ask",
  network_policy: "restricted"
});

describe("NodeClaudeSDKClientFactory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps the default runtime profile to a fail-closed public query surface and exposes interrupt as cancel", async () => {
    const interrupt = vi.fn(async () => {});
    queryMock.mockReturnValue(
      createQuery([
        makeSystemInitMessage(),
        makeFilesPersistedMessage("packages/core/src/index.ts")
      ], { interrupt })
    );

    const factory = new NodeClaudeSDKClientFactory();
    const handle = await factory.startTurn({
      input: { prompt: "continue" },
      sessionConfig: VALID_SESSION_CONFIG
    });

    const queryOptions = expectQueryOptions();
    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryOptions).toMatchObject({
      cwd: "/workspace/project",
      enableFileCheckpointing: true,
      includePartialMessages: true,
      permissionMode: "dontAsk",
      persistSession: false,
      settings: {
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: ["filesystem"],
        allowedMcpServers: [{ serverName: "filesystem" }],
        permissions: {
          defaultMode: "dontAsk"
        }
      },
      tools: [],
      sandbox: expect.objectContaining({
        enabled: true,
        filesystem: {
          allowWrite: ["/workspace/project", "/workspace/cache"]
        }
      })
    });

    const canUseTool = extractCanUseTool();
    await expect(canUseTool("WebFetch", {}, { signal: AbortSignal.timeout(50), toolUseID: "tool-1" })).resolves.toMatchObject({
      behavior: "deny"
    });
    await expect(
      canUseTool("Bash", {}, { signal: AbortSignal.timeout(50), toolUseID: "tool-2" })
    ).resolves.toMatchObject({
      behavior: "deny"
    });
    await expect(
      canUseTool("mcp__filesystem__read_file", {}, { signal: AbortSignal.timeout(50), toolUseID: "tool-3" })
    ).resolves.toMatchObject({
      behavior: "deny"
    });

    const seen: unknown[] = [];
    for await (const message of handle.messages) {
      seen.push(message);
    }

    expect(seen).toHaveLength(2);
    await handle.cancel?.();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime fail-closed when the permission policy is deny", async () => {
    const interrupt = vi.fn(async () => {});
    queryMock.mockReturnValue(
      createQuery([makeSystemInitMessage()], {
        interrupt
      })
    );

    const factory = new NodeClaudeSDKClientFactory();
    const handle = await factory.startTurn({
      input: { prompt: "continue" },
      sessionConfig: RuntimeSessionConfigSchema.parse({
        ...VALID_SESSION_CONFIG,
        network_policy: "enabled",
        permission_policy: "deny",
        sandbox_policy: "read_only",
        writable_roots: ["/workspace/project"]
      })
    });

    const queryOptions = expectQueryOptions();
    expect(queryOptions).toMatchObject({
      permissionMode: "dontAsk",
      sandbox: expect.objectContaining({
        enabled: true,
        filesystem: undefined
      })
    });
    const canUseTool = extractCanUseTool();
    await expect(canUseTool("Bash", {}, { signal: AbortSignal.timeout(50), toolUseID: "tool-4" })).resolves.toMatchObject({
      behavior: "deny"
    });
    await handle.cancel?.();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("disables built-in Claude Code tools for the conversation_engine profile", async () => {
    const interrupt = vi.fn(async () => {});
    queryMock.mockReturnValue(
      createQuery([makeSystemInitMessage()], {
        interrupt
      })
    );

    const factory = new NodeClaudeSDKClientFactory();
    const handle = await factory.startTurn({
      input: { prompt: "continue" },
      sessionConfig: RuntimeSessionConfigSchema.parse({
        ...VALID_SESSION_CONFIG,
        tool_profile: "conversation_engine",
        sandbox_policy: "default",
        network_policy: "disabled",
        writable_roots: []
      })
    });

    const queryOptions = expectQueryOptions();
    expect(queryOptions).toMatchObject({
      permissionMode: "dontAsk",
      tools: [],
      sandbox: undefined
    });
    const canUseTool = extractCanUseTool();
    await expect(
      canUseTool("WebFetch", {}, { signal: AbortSignal.timeout(50), toolUseID: "tool-5" })
    ).resolves.toMatchObject({
      behavior: "deny"
    });
    await handle.cancel?.();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("enables Claude Code built-in tools for the principal coding profile in non-interactive mode without injecting fail-closed tool denial", async () => {
    const interrupt = vi.fn(async () => {});
    queryMock.mockReturnValue(
      createQuery([makeSystemInitMessage()], {
        interrupt
      })
    );

    const factory = new NodeClaudeSDKClientFactory();
    const handle = await factory.startTurn({
      input: { prompt: "continue" },
      sessionConfig: PRINCIPAL_CODING_SESSION_CONFIG
    });

    const queryOptions = expectQueryOptions();
    expect(queryOptions).toMatchObject({
      permissionMode: "auto",
      tools: {
        type: "preset",
        preset: "claude_code"
      },
      settings: {
        permissions: {
          defaultMode: "auto"
        }
      }
    });
    expect(queryOptions.canUseTool).toBeUndefined();

    await handle.cancel?.();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("maps the principal default profile to the Claude Code coding behavior", async () => {
    const interrupt = vi.fn(async () => {});
    queryMock.mockReturnValue(
      createQuery([makeSystemInitMessage()], {
        interrupt
      })
    );

    const factory = new NodeClaudeSDKClientFactory();
    const handle = await factory.startTurn({
      input: { prompt: "continue" },
      sessionConfig: RuntimeSessionConfigSchema.parse({
        ...PRINCIPAL_CODING_SESSION_CONFIG,
        tool_profile: "default"
      })
    });

    const queryOptions = expectQueryOptions();
    expect(queryOptions.tools).toEqual({
      type: "preset",
      preset: "claude_code"
    });
    expect(queryOptions.canUseTool).toBeUndefined();

    await handle.cancel?.();
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("discovers supported slash commands through the public SDK control surface", async () => {
    const supportedCommands = vi.fn(async () => [
      {
        name: "cost",
        description: "Show cost",
        argumentHint: ""
      }
    ]);
    const close = vi.fn();
    queryMock.mockReturnValue(
      createQuery([], {
        supportedCommands,
        close
      })
    );

    const factory = new NodeClaudeSDKClientFactory();

    await expect(
      factory.listSupportedSlashCommands({
        sessionConfig: PRINCIPAL_CODING_SESSION_CONFIG
      })
    ).resolves.toEqual([
      {
        name: "cost",
        description: "Show cost",
        argumentHint: ""
      }
    ]);
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: "" }));
    expect(supportedCommands).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("times out slash command discovery and closes the SDK query", async () => {
    vi.useFakeTimers();
    const supportedCommands = vi.fn(() => new Promise<never>(() => {}));
    const close = vi.fn();
    queryMock.mockReturnValue(
      createQuery([], {
        supportedCommands,
        close
      })
    );

    const factory = new NodeClaudeSDKClientFactory({
      slashCommandDiscoveryTimeoutMs: 10
    });

    const result = factory.listSupportedSlashCommands({
      sessionConfig: PRINCIPAL_CODING_SESSION_CONFIG
    });
    const expectation = expect(result).rejects.toThrow("Claude SDK slash command discovery timed out.");
    await vi.advanceTimersByTimeAsync(10);

    await expectation;
    expect(supportedCommands).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("dispatches slash commands and returns local command output", async () => {
    const close = vi.fn();
    queryMock.mockReturnValue(
      createQuery([
        {
          type: "system",
          subtype: "local_command_output",
          content: "Total cost: $0.01"
        }
      ], {
        close
      })
    );

    const factory = new NodeClaudeSDKClientFactory();

    await expect(
      factory.dispatchSlashCommand({
        sessionConfig: PRINCIPAL_CODING_SESSION_CONFIG,
        command: "/cost"
      })
    ).resolves.toBe("Total cost: $0.01");
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: "/cost" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported runtime tool profiles at the protocol boundary", () => {
    expect(() =>
      RuntimeSessionConfigSchema.parse({
        ...VALID_SESSION_CONFIG,
        tool_profile: "custom_profile"
      })
    ).toThrow(
      "Invalid enum value. Expected 'default' | 'conversation_engine' | 'coding', received 'custom_profile'"
    );

    expect(queryMock).not.toHaveBeenCalled();
  });
});

function expectQueryOptions(): Record<string, unknown> {
  expect(queryMock).toHaveBeenCalled();
  return queryMock.mock.calls.at(-1)?.[0]?.options as Record<string, unknown>;
}

function extractCanUseTool() {
  const options = expectQueryOptions();
  const canUseTool = options.canUseTool;

  expect(typeof canUseTool).toBe("function");
  return canUseTool as (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string }
  ) => Promise<{ behavior: "allow" | "deny"; message?: string }>;
}

function createQuery(
  values: readonly (OfficialSDKSystemMessage | OfficialSDKFilesPersistedEvent | OfficialSDKLocalCommandOutputMessage)[],
  extras: {
    readonly interrupt?: () => Promise<void>;
    readonly supportedCommands?: () => Promise<OfficialSDKSlashCommand[]>;
    readonly close?: () => void;
  } = {}
) {
  const iterator = (async function* () {
    for (const value of values) {
      yield value;
    }
  })();

  return Object.assign(iterator, {
    interrupt: extras.interrupt ?? (async () => {}),
    supportedCommands: extras.supportedCommands ?? (async () => []),
    close: extras.close ?? (() => {})
  }) satisfies QueryHandle;
}

function makeSystemInitMessage(): OfficialSDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    claude_code_version: "2.1.104",
    cwd: "/workspace/project",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-4-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    session_id: "sdk-session-1",
    uuid: "00000000-0000-4000-8000-000000000009"
  } satisfies OfficialSDKSystemMessage;
}

function makeFilesPersistedMessage(filename: string): OfficialSDKFilesPersistedEvent {
  return {
    type: "system",
    subtype: "files_persisted",
    files: [
      {
        file_id: "file-1",
        filename
      }
    ],
    failed: [],
    processed_at: "2026-04-13T10:00:00.000Z",
    session_id: "sdk-session-1",
    uuid: "00000000-0000-4000-8000-000000000010"
  } satisfies OfficialSDKFilesPersistedEvent;
}
