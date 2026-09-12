import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AlayaStatusSchema } from "@do-soul/alaya-protocol";
import { createDaemonMcpRuntimeRegistry } from "../../mcp/catalog/mcp-runtime-registry.js";
import { registerStatusRoutes } from "../../routes/workspace/status/status.js";

describe("status route", () => {
  it("returns the exported AlayaStatus envelope", async () => {
    const app = new Hono();
    registerStatusRoutes(app, {
      startupStepsProvider: () => ["database", "http-app"],
      principalCodingEngineAvailableProvider: () => true,
      mcp: {
        listAllowedServerNames: () => ["filesystem"],
        listEnrolledToolIds: () => ["tool.exec_shell", "tool.write_file"],
        getHealth: () => ({
          servers: [
            {
              server_name: "filesystem",
              status: "active" as const,
              last_error: null
            }
          ]
        })
      },
      clock: () => "2026-04-30T00:00:00.000Z"
    });

    const response = await app.request("/status");
    const body = await response.json() as {
      success: boolean;
      data: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(AlayaStatusSchema.parse(body.data)).toMatchObject({
      checked_at: "2026-04-30T00:00:00.000Z",
      daemon: {
        ready: true,
        startup_steps: ["database", "http-app"],
        principal_coding_engine_available: true
      },
      mcp: {
        enrolled_tools: 2,
        allowed_servers: ["filesystem"],
        catalog_health: {
          servers: [
            {
              server_name: "filesystem",
              status: "active",
              last_error: null
            }
          ]
        }
      }
    });
  });

  it("round-trips a real registry timeout through AlayaStatusSchema", async () => {
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

    const app = new Hono();
    registerStatusRoutes(app, {
      startupStepsProvider: () => ["database", "http-app"],
      principalCodingEngineAvailableProvider: () => true,
      mcp: {
        listAllowedServerNames: () => ["filesystem"],
        listEnrolledToolIds: () => ["tool.exec_shell"],
        getHealth: () => registry.getHealth?.() ?? { servers: [] }
      },
      clock: () => "2026-04-30T00:00:00.000Z"
    });

    const response = await app.request("/status");
    const body = await response.json() as { success: boolean; data: unknown };
    const status = AlayaStatusSchema.parse(body.data);
    expect(status.mcp.catalog_health?.servers[0]?.last_error?.code).toBe("MCP_EXTERNAL_TIMEOUT");
  });
});
