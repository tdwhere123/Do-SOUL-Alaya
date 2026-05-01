import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAlayaCliBridge } from "../cli/bridge.js";
import { registerAlayaCliCommands } from "../cli/register.js";
import type { AlayaDaemonRuntime } from "../index.js";

describe("cli registration", () => {
  it("registers Phase 4 operator commands in bridge order", () => {
    const bridge = createAlayaCliBridge(createRuntime(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });

    registerAlayaCliCommands(bridge, createRuntime());

    expect(bridge.list().map((command) => command.name)).toEqual([
      "doctor",
      "status",
      "install",
      "inspect",
      "attach",
      "detach",
      "tools",
      "mcp",
      "backup",
      "export",
      "import"
    ]);
  });

  it("wires the tools CLI command to the runtime MCP memory handler", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    const bridge = createAlayaCliBridge(createRuntime(), {
      stdin: new PassThrough(),
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, createRuntime());

    const result = await bridge.dispatch([
      "tools",
      "call",
      "soul.open_pointer",
      "{\"object_id\":\"mem1\"}",
      "--workspace",
      "ws1"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ object_id: "mem1" });
    expect(stdoutChunks.join("")).toContain("\"mem1\"");
  });

  it("keeps tools --json output machine-readable with no human prelude", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    const bridge = createAlayaCliBridge(createRuntime(), {
      stdin: new PassThrough(),
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, createRuntime());

    const result = await bridge.dispatch([
      "tools",
      "call",
      "soul.open_pointer",
      "{\"object_id\":\"mem1\"}",
      "--json"
    ]);

    expect(result.exitCode).toBe(0);
    expect(stdoutChunks.join("")).toBe("{\"object_id\":\"mem1\"}\n");
  });
});

function createRuntime(): AlayaDaemonRuntime {
  return {
    app: {} as AlayaDaemonRuntime["app"],
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: "token",
      allowDesktopOriginlessRequests: true
    },
    runtimeNotifier: {} as AlayaDaemonRuntime["runtimeNotifier"],
    startupSteps: [
      { step: "database", completedAt: "2026-04-30T00:00:00.000Z" },
      { step: "repositories", completedAt: "2026-04-30T00:00:00.000Z" },
      { step: "core-services", completedAt: "2026-04-30T00:00:00.000Z" },
      { step: "garden-runtime", completedAt: "2026-04-30T00:00:00.000Z" },
      { step: "mcp-tooling", completedAt: "2026-04-30T00:00:00.000Z" },
      { step: "http-app", completedAt: "2026-04-30T00:00:00.000Z" }
    ],
    services: {
      conversationToolCatalog: {
        getSpecs: () => [],
        hasToolName: () => false
      },
      daemonMcpCatalog: {
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => ["soul.recall"],
        refresh: async () => {}
      },
      environmentStatusService: {
        getStatus: async () => ({
          tools: {},
          active_worktrees: 1,
          db_path: "/tmp/alaya.db",
          files_dir: "/tmp/files"
        })
      },
      embeddingStatusService: {
        getStatus: async (workspaceId) => ({
          workspace_id: workspaceId,
          embedding_enabled: false,
          provider_configured: true,
          model_id: null,
          storage_available: true,
          effective_mode: "keyword_only",
          degraded_reason: null,
          checked_at: "2026-04-30T00:00:00.000Z"
        })
      },
      mcpMemoryToolHandler: {
        call: async () => ({
          ok: true,
          tool_name: "soul.open_pointer",
          output: { object_id: "mem1" }
        })
      },
      trustStateRecorder: {
        summarize: async (agentTarget: string) => ({
          agent_target: agentTarget,
          state: "installed",
          installed_count: 1,
          configured_count: 1,
          delivered_count: 0,
          used_count: 0,
          skipped_count: 0,
          not_applicable_count: 0,
          unverifiable_count: 0,
          last_delivery_at: null,
          last_usage_report_at: null
        }),
        recordInstalled: async () => {},
        recordConfigured: async () => {},
        recordDelivery: async (input) => ({ ...input, audit_event_id: "event1" }),
        recordUsage: async (input) => ({ ...input, audit_event_id: "event2" })
      },
      principalCodingEngineAvailable: true
    },
    startBackgroundServices: () => {},
    runGardenBackgroundPass: async () => {},
    startHttpServer: async () => ({
      hostname: "127.0.0.1",
      port: 3000,
      close: async () => {}
    }),
    shutdown: async () => {}
  };
}
