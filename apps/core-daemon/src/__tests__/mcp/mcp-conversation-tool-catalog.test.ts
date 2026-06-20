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

  it("returns cached frozen spec snapshots until replaceSpecs swaps the snapshot", () => {
    const builtin = [createToolSpec("tools.read_file")] as const;
    const catalog = createConversationToolCatalog(builtin);
    const first = catalog.getSpecs();
    const second = catalog.getSpecs();

    expect(first).toBe(second);
    expect(first).not.toBe(builtin);
    expect(first[0]).not.toBe(builtin[0]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0]!)).toBe(true);

    const replacement = catalog.replaceSpecs([
      ...first,
      createToolSpec("mcp__filesystem__read_file")
    ]);

    expect(replacement).toBe(catalog.getSpecs());
    expect(replacement).not.toBe(first);
    expect(first).toEqual([createToolSpec("tools.read_file")]);
  });

  it("starts extension tool lookups in parallel before syncing the daemon catalog", async () => {
    const lookupGate = createDeferred<void>();
    const lookedUpToolIds: string[] = [];
    const catalog = createConversationToolCatalog();

    const pending = syncConversationToolCatalog({
      catalog,
      extensionRegistry: {
        listProviders: vi.fn(async () => [
          createProvider("provider.mcp.filesystem", [createProviderTool("mcp__filesystem__read_file")]),
          createProvider("provider.mcp.github", [createProviderTool("mcp__github__list_prs")])
        ])
      },
      toolSpecService: {
        findById: vi.fn(async (toolId: string) => {
          lookedUpToolIds.push(toolId);
          await lookupGate.promise;
          return createToolSpec(toolId);
        })
      }
    });

    await Promise.resolve();

    expect(lookedUpToolIds).toEqual([
      "mcp__filesystem__read_file",
      "mcp__github__list_prs"
    ]);

    lookupGate.resolve();
    await pending;
  });

  it("rejects duplicate tool ids during catalog sync instead of silently picking one provider", async () => {
    await expect(syncConversationToolCatalog({
      catalog: createConversationToolCatalog(),
      extensionRegistry: {
        listProviders: vi.fn(async () => [
          createProvider("provider.mcp.alpha", [createProviderTool("mcp__filesystem__read_file")]),
          createProvider("provider.mcp.zeta", [createProviderTool("mcp__filesystem__read_file")])
        ])
      },
      toolSpecService: {
        findById: vi.fn(async () => {
          throw new Error("lookup failed");
        })
      }
    })).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("keeps the parsed MCP tool catalog snapshot across refreshes", async () => {
    const originalAllowedServers = process.env.ALAYA_ALLOWED_MCP_SERVERS;
    const originalToolCatalog = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;
    process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.ALAYA_MCP_TOOL_CATALOG_JSON = JSON.stringify({
      filesystem: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
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
        getServerTools: vi.fn(() => [])
      };

      const catalog = createDaemonMcpCatalogFromEnv({
        now: () => "2026-04-21T00:00:00.000Z",
        runtimeRegistry: runtimeRegistry as unknown as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
      });

      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = "{not valid json";

      await catalog.refresh();

      expect(runtimeRegistry.refresh).toHaveBeenCalledWith({
        serverNames: ["filesystem"]
      });
      await expect(
        catalog.listServerTools({
          server_name: "filesystem",
          transport_type: "stdio",
          status: "active",
          registered_at: "2026-04-21T00:00:00.000Z"
        })
      ).resolves.toEqual([
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Read file through filesystem MCP."
        }
      ]);
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });

  it("re-reads the allowed MCP server allow-list on refresh and drops tools from removed servers", async () => {
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

      expect(catalog.hasTool("mcp__filesystem__read_file")).toBe(true);

      process.env.ALAYA_ALLOWED_MCP_SERVERS = "github";

      expect(catalog.hasTool("mcp__filesystem__read_file")).toBe(false);
      await expect(
        catalog.executeTool({
          toolId: "mcp__filesystem__read_file",
          rawInput: { path: "README.md" },
          writableRoots: ["/workspace/project"]
        })
      ).resolves.toEqual({
        ok: false,
        code: "MCP_EXTERNAL_UNBOUND",
        message: "External MCP tool mcp__filesystem__read_file has no active daemon runtime binding."
      });

      await catalog.refresh();

      expect(runtimeRegistry.refresh).toHaveBeenLastCalledWith({
        serverNames: ["github"]
      });
      expect(catalog.listAllowedServerNames()).toEqual(["github"]);
      expect(catalog.hasTool("mcp__filesystem__read_file")).toBe(false);
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });

  it("fails closed when a builtin-bound tool loses runtime liveness after enrollment", async () => {
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
        listServerTools: vi.fn(async () => {
          throw new Error("filesystem offline");
        }),
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined)
      };

      const catalog = createDaemonMcpCatalogFromEnv({
        now: () => "2026-04-21T00:00:00.000Z",
        runtimeRegistry: runtimeRegistry as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
      });

      expect(catalog.hasTool("mcp__filesystem__read_file")).toBe(true);
      await expect(
        catalog.executeTool({
          toolId: "mcp__filesystem__read_file",
          rawInput: { path: "README.md" },
          writableRoots: ["/workspace/project"]
        })
      ).resolves.toEqual({
        ok: false,
        code: "MCP_EXTERNAL_UNBOUND",
        message: "External MCP tool mcp__filesystem__read_file has no active daemon runtime binding."
      });
    } finally {
      process.env.ALAYA_ALLOWED_MCP_SERVERS = originalAllowedServers;
      process.env.ALAYA_MCP_TOOL_CATALOG_JSON = originalToolCatalog;
    }
  });
});
