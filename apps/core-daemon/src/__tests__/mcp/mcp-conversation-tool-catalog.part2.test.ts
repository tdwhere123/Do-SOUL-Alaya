import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoreError,
  ExtensionRegistryService,
  McpToolDiscoveryService,
  ToolSpecService
} from "@do-soul/alaya-core";

import {
  RuntimeGovernanceEventType,
  type McpServerInfo,
  type ToolProvider,
  type ToolProviderToolSpec,
  type ToolSpec
} from "@do-soul/alaya-protocol";

import {
  bootstrapDaemonConversationTooling,
  createDaemonMcpCatalogFromEnv,
  createConversationToolCatalog,
  syncConversationToolCatalog
} from "../../mcp/mcp-catalog.js";

import {
  SqliteEventLogRepo,
  SqliteExtensionDescriptorRepo,
  SqliteToolSpecRepo,
  initDatabase
} from "@do-soul/alaya-storage";

import { createRuntimeNotifier } from "../../runtime/runtime-notifier.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createProvider(
  providerId: string,
  toolSpecs: readonly Readonly<{ readonly tool_id: string; readonly name: string; readonly description: string; }>[]
): ToolProvider {
  return {
    provider_id: providerId,
    name: providerId,
    source: "mcp_external",
    tool_specs: toolSpecs,
    requires_permission_check: true,
    records_execution: true,
    registered_at: "2026-04-21T00:00:00.000Z"
  };
}

function createProviderTool(toolId: string) {
  return {
    tool_id: toolId,
    name: toolId,
    description: `Provider tool ${toolId}`
  } as const;
}

function createToolSpec(toolId: string): ToolSpec {
  return {
    tool_id: toolId,
    category: toolId === "tools.read_file" ? "read" : "exec",
    description: `Spec for ${toolId}`,
    scope_guard: toolId === "tools.read_file" ? "workspace" : "project",
    read_only: toolId === "tools.read_file",
    destructive: false,
    concurrency_safe: toolId === "tools.read_file",
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: toolId === "tools.read_file"
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("daemon conversation tool catalog", () => {

  it("fails closed when a live MCP server stops exposing a builtin-bound tool after enrollment", async () => {
    const originalAllowedServers = process.env.ALAYA_ALLOWED_MCP_SERVERS;
    const originalToolCatalog = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
    process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });

    try {
      const runtimeRegistry = {
        refresh: vi.fn(async () => undefined),
        listServerInfos: vi.fn(() => [
          {
            server_name: "filesystem",
            transport_type: "stdio" as const,
            status: "active" as const,
            registered_at: "2026-04-21T00:00:00.000Z"
          }
        ]),
        getServerTools: vi.fn(() => []),
        listServerTools: vi.fn(async () => [
          {
            name: "filesystem.list_directory",
            description: "List directory through filesystem MCP."
          }
        ]),
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined)
      };

      const catalog = createDaemonMcpCatalogFromEnv({
        now: () => "2026-04-21T00:00:00.000Z",
        runtimeRegistry: runtimeRegistry as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
      });

      await expect(
        catalog.executeTool({
          toolId: "mcp__filesystem__read_file",
          rawInput: { path: "README.md" },
          writableRoots: ["/workspace/project"]
        })
      ).resolves.toEqual({
        ok: false,
        code: "MCP_EXTERNAL_UNBOUND",
        message: "External MCP tool mcp__filesystem__read_file is no longer exposed by daemon runtime server filesystem."
      });
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });

  it("fails closed when a live MCP server returns an empty tool list for a builtin-bound enrollment", async () => {
    const originalAllowedServers = process.env.ALAYA_ALLOWED_MCP_SERVERS;
    const originalToolCatalog = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
    process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });

    try {
      const runtimeRegistry = {
        refresh: vi.fn(async () => undefined),
        listServerInfos: vi.fn(() => [
          {
            server_name: "filesystem",
            transport_type: "stdio" as const,
            status: "active" as const,
            registered_at: "2026-04-21T00:00:00.000Z"
          }
        ]),
        getServerTools: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined)
      };

      const catalog = createDaemonMcpCatalogFromEnv({
        now: () => "2026-04-21T00:00:00.000Z",
        runtimeRegistry: runtimeRegistry as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
      });

      await expect(
        catalog.executeTool({
          toolId: "mcp__filesystem__read_file",
          rawInput: { path: "README.md" },
          writableRoots: ["/workspace/project"]
        })
      ).resolves.toEqual({
        ok: false,
        code: "MCP_EXTERNAL_UNBOUND",
        message: "External MCP tool mcp__filesystem__read_file is no longer exposed by daemon runtime server filesystem."
      });
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });

  it("preserves builtin execution errors for still-exposed builtin-bound MCP tools", async () => {
    const originalAllowedServers = process.env.ALAYA_ALLOWED_MCP_SERVERS;
    const originalToolCatalog = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
    process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP.",
          daemon_binding: {
            binding_kind: "builtin_tool",
            builtin_tool_id: "tools.read_file"
          }
        }
      ]
    });

    try {
      const runtimeRegistry = {
        refresh: vi.fn(async () => undefined),
        listServerInfos: vi.fn(() => [
          {
            server_name: "filesystem",
            transport_type: "stdio" as const,
            status: "active" as const,
            registered_at: "2026-04-21T00:00:00.000Z"
          }
        ]),
        getServerTools: vi.fn(() => []),
        listServerTools: vi.fn(async () => [
          {
            name: "filesystem.read_file",
            description: "Read file through filesystem MCP."
          }
        ]),
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined)
      };

      const catalog = createDaemonMcpCatalogFromEnv({
        now: () => "2026-04-21T00:00:00.000Z",
        runtimeRegistry: runtimeRegistry as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
      });

      await expect(
        catalog.executeTool({
          toolId: "mcp__filesystem__read_file",
          rawInput: { path: 123 },
          writableRoots: ["/workspace/project"]
        })
      ).rejects.toThrow(/Invalid input for tools\.read_file/);
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });

  it("bootstraps the builtin conversation provider through the daemon helper onto extension descriptors", async () => {
    const registerProvider = vi.fn(async (provider: Readonly<ToolProvider>) => provider);
    const toolSpecService = {
      findById: vi.fn(async (toolId: string) => {
        throw new CoreError("NOT_FOUND", `Missing ${toolId}`);
      }),
      register: vi.fn(async (spec: Readonly<ToolSpec>) => spec),
      update: vi.fn(async (spec: Readonly<ToolSpec>) => spec)
    };

    await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      extensionRegistry: {
        listProviders: vi.fn(async () => []),
        registerProvider
      },
      mcpToolDiscoveryService: {
        discoverAndRegister: vi.fn(async () => [])
      },
      runtimeRegistry: {
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined),
        getServerTools: vi.fn(() => []),
        listServerInfos: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        refresh: vi.fn(async () => undefined)
      },
      toolSpecService
    });

    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_id: "provider.builtin.conversation_engine"
      })
    );
    expect(toolSpecService.register).toHaveBeenCalled();
  });

  it("keeps builtin tools out of the live daemon catalog when descriptor authority does not expose them", async () => {
    const tooling = await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      extensionRegistry: {
        listProviders: vi.fn(async () => []),
        registerProvider: vi.fn(async (provider: Readonly<ToolProvider>) => provider)
      },
      mcpToolDiscoveryService: {
        discoverAndRegister: vi.fn(async () => [])
      },
      runtimeRegistry: {
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined),
        getServerTools: vi.fn(() => []),
        listServerInfos: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        refresh: vi.fn(async () => undefined)
      },
      toolSpecService: {
        findById: vi.fn(async (toolId: string) => createToolSpec(toolId)),
        register: vi.fn(async (spec: Readonly<ToolSpec>) => spec),
        update: vi.fn(async (spec: Readonly<ToolSpec>) => spec)
      }
    });

    expect(tooling.conversationToolCatalog.getSpecs()).toEqual([]);
    expect(tooling.externalConversationToolExecutor.hasTool("tools.read_file")).toBe(false);
    await expect(
      tooling.externalConversationToolExecutor.executeTool({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          surface_id: null,
          user_message_id: "msg-user-1",
          assistant_message_id: "msg-assistant-1"
        },
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toEqual({
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND",
      message: "External conversation tool tools.read_file is not registered in the daemon catalog."
    });
  });
});
