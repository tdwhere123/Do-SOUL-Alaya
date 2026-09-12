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

function enrollBuiltinBoundFilesystemTool(): void {
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
}

function createCatalog(listServerTools: () => Promise<readonly { readonly name: string; readonly description: string }[]>) {
  return createDaemonMcpCatalogFromEnv({
    now: () => "2026-04-21T00:00:00.000Z",
    runtimeRegistry: {
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
      listServerTools,
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined)
    } as Parameters<typeof createDaemonMcpCatalogFromEnv>[0]["runtimeRegistry"]
  });
}

describe("daemon MCP catalog listServerTools failures", () => {
  it("classifies timeout messages separately from transport failures", () => {
    expect(classifyDaemonMcpListFailure(new Error("MCP runtime connection timed out after 10ms"))).toBe(
      "MCP_EXTERNAL_TIMEOUT"
    );
    expect(classifyDaemonMcpListFailure(Object.assign(new Error("socket hang"), { code: "ECONNRESET" }))).toBe(
      "MCP_EXTERNAL_TRANSPORT"
    );
  });

  it("does not map a transport list failure to unbound", async () => {
    enrollBuiltinBoundFilesystemTool();
    const catalog = createCatalog(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });

    await expect(
      catalog.executeTool({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toEqual({
      ok: false,
      code: "MCP_EXTERNAL_TRANSPORT",
      message:
        "External MCP tool mcp__filesystem__read_file failed because listing tools from daemon runtime server filesystem transport failed."
    });
  });

  it("maps a list timeout to MCP_EXTERNAL_TIMEOUT", async () => {
    enrollBuiltinBoundFilesystemTool();
    const catalog = createCatalog(async () => {
      throw new Error("MCP runtime connection timed out after 10ms");
    });

    await expect(
      catalog.executeTool({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toEqual({
      ok: false,
      code: "MCP_EXTERNAL_TIMEOUT",
      message:
        "External MCP tool mcp__filesystem__read_file failed because listing tools from daemon runtime server filesystem timed out."
    });
  });

  it("keeps unbound for an empty live tool list", async () => {
    enrollBuiltinBoundFilesystemTool();
    const catalog = createCatalog(async () => []);

    await expect(
      catalog.executeTool({
        toolId: "mcp__filesystem__read_file",
        rawInput: { path: "README.md" },
        writableRoots: ["/workspace/project"]
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "MCP_EXTERNAL_UNBOUND"
    });
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
            message: "MCP runtime connection timed out after 10ms"
          }
        })
      ]
    });
  });
});
