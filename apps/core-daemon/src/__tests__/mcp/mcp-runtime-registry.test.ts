import { describe, expect, it, vi } from "vitest";
import {
  createDaemonMcpRuntimeClientInfo,
  createDaemonMcpRuntimeRegistry
} from "../../mcp/mcp-runtime-registry.js";
import { createDeferred } from "../support/deferred.js";

describe("daemon MCP runtime registry", () => {
  it("requires an explicit warn handler instead of silently swallowing cleanup errors", () => {
    expect(() =>
      createDaemonMcpRuntimeRegistry({
        serverConfigs: {
          filesystem: {
            transportType: "stdio",
            command: process.execPath
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
          command: process.execPath
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
          command: process.execPath,
          args: ["./mock-filesystem-server.js"]
        }
      },
      createClient,
      createStdioTransport,
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 25,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    const result = await registry.callTool({
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    });

    expect(createStdioTransport).toHaveBeenCalledWith({
      command: process.execPath,
      args: ["./mock-filesystem-server.js"],
      cwd: undefined,
      env: undefined,
      stderr: "inherit"
    });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.anything(), {
      timeout: 25,
      maxTotalTimeout: 25
    });
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "filesystem.read_file",
        arguments: { path: "README.md" }
      },
      expect.anything(),
      {
        timeout: 25,
        maxTotalTimeout: 25
      }
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }]
    });
  });

  it("bounds tool catalog requests with the configured SDK request timeout", async () => {
    const listTools = vi.fn(async () => ({ tools: [] }));
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: { transportType: "stdio", command: process.execPath }
      },
      createClient: vi.fn(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools
      })),
      createStdioTransport: vi.fn(() => ({ kind: "stdio" })),
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 40,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    await registry.listServerTools("filesystem");

    expect(listTools).toHaveBeenCalledWith(undefined, {
      timeout: 40,
      maxTotalTimeout: 40
    });
  });

  it("times out a hanging transport connection, bounds cleanup, and reconnects", async () => {
    const firstClientClose = vi.fn(() => new Promise<void>(() => undefined));
    const firstTransportClose = vi.fn(async () => undefined);
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => ({
        close: firstClientClose,
        connect: vi.fn(() => new Promise<void>(() => undefined)),
        callTool: vi.fn(),
        listTools: vi.fn()
      }))
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [{ type: "text", text: "reconnected" }] })),
        listTools: vi.fn(async () => ({ tools: [] }))
      }));
    const createStdioTransport = vi
      .fn()
      .mockImplementationOnce(() => ({ kind: "stdio", close: firstTransportClose }))
      .mockImplementationOnce(() => ({ kind: "stdio", close: vi.fn(async () => undefined) }));
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: { filesystem: { transportType: "stdio", command: process.execPath } },
      createClient,
      createStdioTransport,
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 10,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);
    const call = {
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    } as const;

    await expect(withTestDeadline(registry.callTool(call))).rejects.toThrow(
      "MCP runtime connection timed out after 10ms"
    );
    await expect(registry.callTool(call)).resolves.toEqual({
      content: [{ type: "text", text: "reconnected" }]
    });

    expect(firstClientClose).toHaveBeenCalledTimes(1);
    expect(firstTransportClose).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale failed handle deactivate its replacement", async () => {
    const firstFailure = createDeferred<never>();
    const secondFailure = createDeferred<never>();
    const firstCallTool = vi
      .fn()
      .mockImplementationOnce(() => firstFailure.promise)
      .mockImplementationOnce(() => secondFailure.promise);
    const replacementCallTool = vi.fn(async () => ({
      content: [{ type: "text", text: "replacement" }]
    }));
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: firstCallTool,
        listTools: vi.fn(async () => ({ tools: [] }))
      }))
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: replacementCallTool,
        listTools: vi.fn(async () => ({ tools: [] }))
      }));
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: { filesystem: { transportType: "stdio", command: process.execPath } },
      createClient,
      createStdioTransport: vi.fn(() => ({ kind: "stdio", close: vi.fn(async () => undefined) })),
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 500,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);
    const call = {
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    } as const;
    const staleFirst = registry.callTool(call);
    const staleSecond = registry.callTool(call);

    firstFailure.reject(new Error("first stale failure"));
    await expect(staleFirst).rejects.toThrow("first stale failure");
    await expect(registry.callTool(call)).resolves.toEqual({
      content: [{ type: "text", text: "replacement" }]
    });
    secondFailure.reject(new Error("second stale failure"));
    await expect(staleSecond).rejects.toThrow("second stale failure");
    await expect(registry.callTool(call)).resolves.toEqual({
      content: [{ type: "text", text: "replacement" }]
    });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(replacementCallTool).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale successful call reactivate a removed handle", async () => {
    const staleFailure = createDeferred<never>();
    const staleSuccess = createDeferred<{ content: readonly unknown[] }>();
    const callTool = vi
      .fn()
      .mockImplementationOnce(() => staleFailure.promise)
      .mockImplementationOnce(() => staleSuccess.promise);
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: { filesystem: { transportType: "stdio", command: process.execPath } },
      createClient: vi.fn(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool,
        listTools: vi.fn(async () => ({ tools: [] }))
      })),
      createStdioTransport: vi.fn(() => ({ kind: "stdio", close: vi.fn(async () => undefined) })),
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 500,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);
    const call = {
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    } as const;
    const failedCall = registry.callTool(call);
    const successfulCall = registry.callTool(call);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));

    staleFailure.reject(new Error("stale failure"));
    await expect(failedCall).rejects.toThrow("stale failure");
    staleSuccess.resolve({ content: [] });
    await expect(successfulCall).resolves.toEqual({ content: [] });

    expect(registry.listServerInfos()[0]?.status).toBe("inactive");
  });

  it("does not let a stale successful refresh overwrite a replacement catalog", async () => {
    const staleFailure = createDeferred<never>();
    const staleSuccess = createDeferred<{ tools: readonly { name: string }[] }>();
    const firstListTools = vi
      .fn()
      .mockImplementationOnce(() => staleFailure.promise)
      .mockImplementationOnce(() => staleSuccess.promise);
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: firstListTools
      }))
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => ({ tools: [{ name: "replacement.tool" }] }))
      }));
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: { filesystem: { transportType: "stdio", command: process.execPath } },
      createClient,
      createStdioTransport: vi.fn(() => ({ kind: "stdio", close: vi.fn(async () => undefined) })),
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 500,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);
    const target = { serverNames: ["filesystem"] } as const;
    const failedRefresh = registry.refresh(target);
    const successfulRefresh = registry.refresh(target);
    await vi.waitFor(() => expect(firstListTools).toHaveBeenCalledTimes(2));

    staleFailure.reject(new Error("stale refresh failure"));
    await failedRefresh;
    await registry.refresh(target);
    staleSuccess.resolve({ tools: [{ name: "stale.tool" }] });
    await successfulRefresh;

    expect(registry.getServerTools("filesystem")).toEqual([
      { name: "replacement.tool", description: "MCP tool replacement.tool" }
    ]);
  });

  it("cleans up a failed tool connection and reconnects on the next call", async () => {
    const firstClientClose = vi.fn(async () => undefined);
    const firstTransportClose = vi.fn(async () => undefined);
    const secondCallTool = vi.fn(async () => ({ content: [{ type: "text", text: "recovered" }] }));
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => ({
        close: firstClientClose,
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => {
          throw new Error("request timed out");
        }),
        listTools: vi.fn(async () => ({ tools: [] }))
      }))
      .mockImplementationOnce(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: secondCallTool,
        listTools: vi.fn(async () => ({ tools: [] }))
      }));
    const createStdioTransport = vi
      .fn()
      .mockImplementationOnce(() => ({ kind: "stdio", close: firstTransportClose }))
      .mockImplementationOnce(() => ({ kind: "stdio", close: vi.fn(async () => undefined) }));
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: { transportType: "stdio", command: process.execPath }
      },
      createClient,
      createStdioTransport,
      createStreamableHttpTransport: vi.fn(),
      requestTimeoutMs: 25,
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);
    const call = {
      serverName: "filesystem",
      toolName: "filesystem.read_file",
      input: { path: "README.md" }
    } as const;

    await expect(registry.callTool(call)).rejects.toThrow("request timed out");
    await expect(registry.callTool(call)).resolves.toEqual({
      content: [{ type: "text", text: "recovered" }]
    });

    expect(firstClientClose).toHaveBeenCalledTimes(1);
    expect(firstTransportClose).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(secondCallTool).toHaveBeenCalledTimes(1);
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
          command: process.execPath
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

});

async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test deadline exceeded")), 250);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
