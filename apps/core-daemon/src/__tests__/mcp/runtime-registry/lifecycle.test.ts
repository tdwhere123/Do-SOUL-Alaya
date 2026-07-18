import { describe, expect, it, vi } from "vitest";
import { createDaemonMcpRuntimeRegistry } from "../../../mcp/mcp-runtime-registry.js";

describe("daemon MCP runtime registry lifecycle", () => {
  it("marks servers active only after a successful refresh and deactivates them after refresh failure", async () => {
    let listedTools = [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ];
    const listTools = vi
      .fn(async () => ({ tools: listedTools }))
      .mockImplementationOnce(async () => ({ tools: listedTools }))
      .mockImplementationOnce(async () => ({ tools: listedTools }))
      .mockImplementationOnce(async () => {
        throw new Error("filesystem offline");
      });
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: process.execPath,
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

    expect(registry.listServerInfos()[0]?.status).toBe("inactive");
    await registry.refresh();
    expect(registry.listServerInfos()[0]?.status).toBe("active");

    listedTools = [
      { name: "filesystem.read_file", description: "Read file through filesystem MCP." },
      {
        name: "filesystem.list_directory",
        description: "List directory through filesystem MCP."
      }
    ];
    await registry.refresh();
    expect(registry.getServerTools("filesystem")).toEqual(listedTools);

    await expect(registry.refresh()).resolves.toBeUndefined();
    expect(registry.listServerInfos()[0]?.status).toBe("inactive");
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
          command: process.execPath,
          args: ["./mock-filesystem-server.js"]
        },
        github: { transportType: "http", endpoint: "http://127.0.0.1:3040/mcp" }
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
          command: process.execPath,
          args: ["./mock-filesystem-server.js"]
        }
      },
      createClient: vi.fn(() => ({
        close: vi.fn(async () => { throw new Error("client close failed"); }),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => ({ tools: [] }))
      })),
      createStdioTransport: vi.fn(() => ({
        kind: "stdio",
        close: vi.fn(async () => { throw new Error("transport close failed"); })
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
