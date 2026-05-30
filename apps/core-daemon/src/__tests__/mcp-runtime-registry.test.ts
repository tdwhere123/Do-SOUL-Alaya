import { WritableStream } from "node:stream/web";
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
} from "../mcp-catalog.js";
import { createDaemonMcpRuntimeRegistry } from "../mcp-runtime-registry.js";
import {
  SqliteEventLogRepo,
  SqliteExtensionDescriptorRepo,
  SqliteToolSpecRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { createRuntimeNotifier } from "../runtime-notifier.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("daemon MCP runtime registry", () => {
  it("requires an explicit warn handler instead of silently swallowing cleanup errors", () => {
    expect(() =>
      createDaemonMcpRuntimeRegistry({
        serverConfigs: {
          filesystem: {
            transportType: "stdio",
            command: "node"
          }
        },
        createClient: vi.fn(),
        createStdioTransport: vi.fn(),
        createStreamableHttpTransport: vi.fn(),
        now: () => "2026-04-21T00:00:00Z"
      } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0])
    ).toThrow("requires an explicit warn handler");
  });

  it("normalizes server registration timestamps through the shared ISO helper", () => {
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node"
        }
      },
      createClient: vi.fn(),
      createStdioTransport: vi.fn(),
      createStreamableHttpTransport: vi.fn(),
      now: () => "2026-04-21T00:00:00Z",
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    expect(registry.listServerInfos()).toEqual([
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "inactive",
        registered_at: "2026-04-21T00:00:00.000Z"
      }
    ]);
  });

  it("executes configured stdio MCP tools through a connected client", async () => {
    const connect = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }]
    }));
    const listTools = vi.fn(async () => ({ tools: [] }));
    const createClient = vi.fn(() => ({
      connect,
      callTool,
      listTools
    }));
    const createStdioTransport = vi.fn((params) => ({ kind: "stdio", params }));

    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node",
          args: ["./mock-filesystem-server.js"]
        }
      },
      createClient,
      createStdioTransport,
      createStreamableHttpTransport: vi.fn(),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    const result = await registry.callTool({
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    });

    expect(createStdioTransport).toHaveBeenCalledWith({
      command: "node",
      args: ["./mock-filesystem-server.js"],
      cwd: undefined,
      env: undefined,
      stderr: "inherit"
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "filesystem.read_file",
        arguments: { path: "README.md" }
      },
      expect.anything()
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }]
    });
  });

  it("normalizes MCP tool failures into structured daemon errors", async () => {
    const createClient = vi.fn(() => ({
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(async () => ({
        isError: true,
        content: [{ type: "text", text: "permission denied" }]
      }))
    }));

    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "http",
          endpoint: "http://127.0.0.1:3040/mcp"
        }
      },
      createClient,
      createStdioTransport: vi.fn(),
      createStreamableHttpTransport: vi.fn(() => ({ kind: "http" })),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    const result = await registry.callTool({
      serverName: "filesystem",
      toolName: "filesystem.write_file",
      input: { path: "README.md", content: "hello" }
    });

    expect(result).toEqual({
      ok: false,
      code: "MCP_TOOL_ERROR",
      message: "permission denied",
      content: [{ type: "text", text: "permission denied" }]
    });
  });

  it("marks servers active only after a successful refresh and deactivates them after refresh failure", async () => {
    let listedTools = [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ];
    const listTools = vi
      .fn(async () => ({
        tools: listedTools
      }))
      .mockImplementationOnce(async () => ({
        tools: listedTools
      }))
      .mockImplementationOnce(async () => ({
        tools: listedTools
      }))
      .mockImplementationOnce(async () => {
        throw new Error("filesystem offline");
      });

    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node",
          args: ["./mock-filesystem-server.js"]
        }
      },
      createClient: vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools
      })),
      createStdioTransport: vi.fn(() => ({ kind: "stdio" })),
      createStreamableHttpTransport: vi.fn(),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    expect(registry.listServerInfos()).toEqual([
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "inactive",
        registered_at: expect.any(String)
      }
    ]);

    await registry.refresh();
    expect(registry.listServerInfos()).toEqual([
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "active",
        registered_at: expect.any(String)
      }
    ]);
    listedTools = [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        name: "filesystem.list_directory",
        description: "List directory through filesystem MCP."
      }
    ];
    await registry.refresh();
    expect(registry.listServerInfos()).toEqual([
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "active",
        registered_at: expect.any(String)
      }
    ]);

    expect(registry.getServerTools("filesystem")).toEqual([
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        name: "filesystem.list_directory",
        description: "List directory through filesystem MCP."
      }
    ]);

    await expect(registry.refresh()).resolves.toBeUndefined();
    expect(registry.listServerInfos()).toEqual([
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "inactive",
        registered_at: expect.any(String)
      }
    ]);
    expect(registry.getServerTools("filesystem")).toEqual([]);
  });

  it("closes connected MCP clients and transports during daemon shutdown", async () => {
    const closeFilesystem = vi.fn(async () => undefined);
    const closeGithub = vi.fn(async () => undefined);
    const closeFilesystemTransport = vi.fn(async () => undefined);
    const closeGithubTransport = vi.fn(async () => undefined);
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => ({
        close: closeFilesystem,
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => ({ tools: [] }))
      }))
      .mockImplementationOnce(() => ({
        close: closeGithub,
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => ({ tools: [] }))
      }));

    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node",
          args: ["./mock-filesystem-server.js"]
        },
        github: {
          transportType: "http",
          endpoint: "http://127.0.0.1:3040/mcp"
        }
      },
      createClient,
      createStdioTransport: vi.fn(() => ({
        kind: "stdio",
        close: closeFilesystemTransport
      })),
      createStreamableHttpTransport: vi.fn(() => ({
        kind: "http",
        close: closeGithubTransport
      })),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    await registry.callTool({
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    });
    await registry.refresh({ serverNames: ["github"] });

    await registry.close();

    expect(closeFilesystem).toHaveBeenCalledTimes(1);
    expect(closeGithub).toHaveBeenCalledTimes(1);
    expect(closeFilesystemTransport).toHaveBeenCalledTimes(1);
    expect(closeGithubTransport).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to raw console warnings when an explicit noop warn is injected", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warn = vi.fn();
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node",
          args: ["./mock-filesystem-server.js"]
        }
      },
      createClient: vi.fn(() => ({
        close: vi.fn(async () => {
          throw new Error("client close failed");
        }),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => ({ tools: [] }))
      })),
      createStdioTransport: vi.fn(() => ({
        kind: "stdio",
        close: vi.fn(async () => {
          throw new Error("transport close failed");
        })
      })),
      createStreamableHttpTransport: vi.fn(),
      warn
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    try {
      await registry.refresh();
      await registry.close();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
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

  it("appends and broadcasts extension.tool_discovered on the daemon bootstrap discovery path", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);

    const toolSpecService = new ToolSpecService({
      toolSpecRepo: new SqliteToolSpecRepo(database)
    });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const runtimeNotifier = createRuntimeNotifier();
    const notifyEntrySpy = vi.spyOn(runtimeNotifier, "notifyEntry");
    const extensionRegistry = new ExtensionRegistryService({
      extensionStore: new SqliteExtensionDescriptorRepo(database),
      toolSpecService,
      eventLogWriter: eventLogRepo,
      runtimeNotifier,
      defaultWorkspaceId: "system"
    });
    const server: McpServerInfo = {
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-21T00:00:00.000Z"
    };
    const discoveredTool: ToolProviderToolSpec = {
      tool_id: "mcp__filesystem__read_file",
      name: "filesystem.read_file",
      description: "Read file through filesystem MCP."
    };
    const daemonMcpCatalog = {
      servers: [server] as const,
      refresh: vi.fn(async () => undefined),
      listAllowedServerNames: vi.fn(() => ["filesystem"]),
      listEnrolledToolIds: vi.fn(() => [discoveredTool.tool_id]),
      listServerTools: vi.fn(async () => [discoveredTool]),
      hasTool: vi.fn(() => true),
      executeTool: vi.fn(async () => ({ ok: true }))
    };
    const mcpToolDiscoveryService = new McpToolDiscoveryService({
      extensionRegistry,
      mcpToolCatalog: daemonMcpCatalog,
      eventLogWriter: eventLogRepo,
      runtimeNotifier,
      now: () => "2026-04-21T00:00:00.000Z",
      defaultWorkspaceId: "system"
    });
    const tooling = await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      daemonMcpCatalog,
      extensionRegistry,
      mcpToolDiscoveryService,
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

    await waitForCondition(() =>
      notifyEntrySpy.mock.calls.some(
        ([entry]) => entry.event_type === RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED
      )
    );

    await expect(eventLogRepo.queryByType(RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED)).resolves.toEqual([
      expect.objectContaining({
        workspace_id: "system",
        entity_type: "extension_provider",
        entity_id: "provider.mcp.filesystem",
        payload_json: expect.objectContaining({
          tool_id: discoveredTool.tool_id,
          tool_name: discoveredTool.name,
          source: "mcp_external"
        })
      })
    ]);
    expect(tooling.conversationToolCatalog.getSpecs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_id: discoveredTool.tool_id
        })
      ])
    );
    expect(notifyEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED
      })
    );
  });
});

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

function createSseCapture(): {
  readonly text: () => string;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  const writer = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
    }
  }).getWriter();

  return {
    text: () => buffer,
    writer
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
