import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonMcpCatalogFromEnv } from "../../mcp/catalog/mcp-catalog.js";
import {
  classifyDaemonMcpListFailure,
  createDaemonMcpRuntimeRegistry
} from "../../mcp/catalog/mcp-runtime-registry.js";
import { restoreProcessEnv } from "../support/restore-process-env.js";

afterEach(() => {
  restoreProcessEnv("ALAYA_ALLOWED_MCP_SERVERS", originalAllowedServers);
  restoreProcessEnv("ALAYA_MCP_TOOL_CATALOG_JSON", originalToolCatalog);
});

const originalAllowedServers = process.env.ALAYA_ALLOWED_MCP_SERVERS;
const originalToolCatalog = process.env.ALAYA_MCP_TOOL_CATALOG_JSON;

function configureFilesystemTool(retired: boolean): void {
  process.env.ALAYA_ALLOWED_MCP_SERVERS = "filesystem";
  process.env.ALAYA_MCP_TOOL_CATALOG_JSON = JSON.stringify({
    filesystem: [
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP.",
        daemon_binding: retired ? {
          binding_kind: "builtin_tool",
          builtin_tool_id: "tools.read_file"
        } : { binding_kind: "mcp_tool" }
      }
    ]
  });
}

describe("daemon MCP catalog listServerTools failures", () => {
  it.each([false, true])("does not enroll retired builtin bindings (live discovery: %s)", async (discovered) => {
    configureFilesystemTool(true);
    const callTool = vi.fn(async () => ({ content: [] }));
    const listServerTools = vi.fn(async () => []);
    const server = {
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: "2026-04-21T00:00:00.000Z"
    } as const;
    const catalog = createDaemonMcpCatalogFromEnv({
      now: () => server.registered_at,
      runtimeRegistry: {
        refresh: vi.fn(async () => undefined),
        listServerInfos: () => [server],
        getServerTools: () => discovered ? [{ name: "filesystem.read_file", description: "Read file" }] : [],
        listServerTools,
        callTool,
        close: vi.fn(async () => undefined),
        getHealth: () => ({ servers: [] })
      },
      warn: vi.fn()
    });

    const toolId = "mcp__filesystem__read_file";
    expect(catalog.listEnrolledToolIds()).toEqual([]);
    expect(catalog.hasTool(toolId)).toBe(false);
    await expect(catalog.listServerTools(server)).resolves.toEqual([]);
    await expect(catalog.executeTool({ toolId, rawInput: {}, writableRoots: [] }))
      .resolves.toMatchObject({ ok: false, code: "MCP_EXTERNAL_UNBOUND" });
    expect(listServerTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("classifies timeout messages separately from transport failures", () => {
    expect(classifyDaemonMcpListFailure(new Error("MCP runtime connection timed out after 10ms"))).toBe(
      "MCP_EXTERNAL_TIMEOUT"
    );
    expect(classifyDaemonMcpListFailure(Object.assign(new Error("socket hang"), { code: "ECONNRESET" }))).toBe(
      "MCP_EXTERNAL_TRANSPORT"
    );
  });

  it("records catalog health from a real runtime list timeout", async () => {
    const registry = createDaemonMcpRuntimeRegistry({
      serverConfigs: {
        filesystem: {
          transportType: "stdio",
          command: process.execPath
        }
      },
      createClient: vi.fn(() => ({
        close: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async () => ({ content: [] })),
        listTools: vi.fn(async () => {
          throw new Error("MCP runtime connection timed out after 10ms");
        })
      })),
      createStdioTransport: vi.fn(() => ({ kind: "stdio" })),
      createStreamableHttpTransport: vi.fn(),
      warn: vi.fn()
    } as unknown as Parameters<typeof createDaemonMcpRuntimeRegistry>[0]);

    await expect(registry.listServerTools("filesystem")).rejects.toThrow(/timed out after 10ms/);
    expect(registry.getHealth?.()).toEqual({
      servers: [
        expect.objectContaining({
          server_name: "filesystem",
          status: "inactive",
          last_error: {
            code: "MCP_EXTERNAL_TIMEOUT",
            message: "External MCP server timed out."
          }
        })
      ]
    });
  });

  it("returns the classified list timeout when execute runs after the server is inactive", async () => {
    configureFilesystemTool(false);
    const live = { current: true };
    const lastError = {
      current: null as null | {
        readonly code: "MCP_EXTERNAL_TIMEOUT" | "MCP_EXTERNAL_TRANSPORT";
        readonly message: string;
      }
    };
    const catalog = createDaemonMcpCatalogFromEnv({
      now: () => "2026-04-21T00:00:00.000Z",
      runtimeRegistry: {
        refresh: vi.fn(async () => undefined),
        listServerInfos: vi.fn(() => [
          {
            server_name: "filesystem",
            transport_type: "stdio" as const,
            status: live.current ? ("active" as const) : ("inactive" as const),
            registered_at: "2026-04-21T00:00:00.000Z"
          }
        ]),
        getHealth: vi.fn(() => ({
          servers: [
            {
              server_name: "filesystem",
              status: live.current ? ("active" as const) : ("inactive" as const),
              last_error: lastError.current
            }
          ]
        })),
        getServerTools: vi.fn(() => []),
        listServerTools: vi.fn(async () => [{ name: "filesystem.read_file", description: "Read file" }]),
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined)
      } as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
    });

    live.current = false;
    lastError.current = {
      code: "MCP_EXTERNAL_TIMEOUT",
      message: "External MCP server timed out."
    };

    await expect(
      catalog.executeTool({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toEqual({
      ok: false,
      code: "MCP_EXTERNAL_TIMEOUT",
      message: "External MCP server timed out."
    });
  });
});
