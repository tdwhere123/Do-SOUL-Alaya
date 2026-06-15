import { describe, expect, it, vi } from "vitest";
import {
  createDaemonMcpRuntimeClientInfo,
  createDaemonMcpRuntimeRegistry
} from "../../mcp/mcp-runtime-registry.js";

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

  it("passes derived runtime client info to injected MCP clients", async () => {
    const connect = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({
      close: vi.fn(async () => undefined),
      connect,
      callTool: vi.fn(async () => ({ content: [] })),
      listTools: vi.fn(async () => ({ tools: [] }))
    }));

    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: "node"
        }
      },
      createClient,
      createStdioTransport: vi.fn(() => ({ kind: "stdio" })),
      createStreamableHttpTransport: vi.fn(),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    await registry.callTool({
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    });

    expect(createClient).toHaveBeenCalledWith(createDaemonMcpRuntimeClientInfo());
    expect(createDaemonMcpRuntimeClientInfo().version).not.toBe("0.0.1");
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
