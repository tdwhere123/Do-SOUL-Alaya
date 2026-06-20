import { PassThrough } from "node:stream";

import { CoreError } from "@do-soul/alaya-core";

import type { ContextDeliveryRecord, UsageProofRecord } from "@do-soul/alaya-protocol";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAlayaCliBridge } from "../../cli/bridge.js";

import { registerAlayaCliCommands } from "../../cli/register.js";

import type { AlayaDaemonRuntime } from "../../index.js";

const hoisted = vi.hoisted(() => ({
  runAlayaMcpStdioServer: vi.fn(),
  serverClose: vi.fn(async () => {})
}));

vi.mock("../../mcp/mcp-server.js", () => ({
  runAlayaMcpStdioServer: hoisted.runAlayaMcpStdioServer
}));

function createRuntime(overrides: Partial<AlayaDaemonRuntime> = {}): AlayaDaemonRuntime {
  const runtime: AlayaDaemonRuntime = {
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
        getStatus: async (workspaceId: string) => ({
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
      graphHealthService: {
        getStatus: async (workspaceId: string) => ({
          workspace_id: workspaceId,
          status: "healthy",
          path_relations_total: 1,
          path_relations_by_kind: {
            supports: 1
          },
          latest_path_event_at: "2026-04-30T00:00:00.000Z",
          warnings: [],
          hint: null
        })
      },
      mcpMemoryToolHandler: {
        call: async () => ({
          ok: true,
          tool_name: "soul.open_pointer",
          output: { object_id: "mem1" }
        })
      },
      runService: {
        getById: vi.fn(async (runId: string) => createRun({ run_id: runId, workspace_id: "workspace-1" })),
        ensureAttachedMcpSessionRun: vi.fn(async (input) =>
          createRun({ run_id: input.sessionId, workspace_id: input.workspaceId })
        )
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
        recordDelivery: async (input: Omit<ContextDeliveryRecord, "audit_event_id">) => ({
          ...input,
          audit_event_id: "event1"
        }),
        recordUsage: async (input: Omit<UsageProofRecord, "audit_event_id">) => ({
          ...input,
          audit_event_id: "event2"
        }),
        findDeliveryById: async () => null
      },
      workspaceService: {
        ensureLocalWorkspace: async () => undefined,
        reconcileBootstrapPaths: async () => ({
          status: "already_planted" as const,
          workspace_id: "workspace-1",
          record_id: "bootstrap-record-1",
          relation_count: 1
        })
      },
      principalCodingEngineAvailable: true
    } as unknown as AlayaDaemonRuntime["services"],
    startBackgroundServices: () => {},
    runGardenBackgroundPass: async () => {},
    runGardenBulkEnrichPass: async () => {},
    runGardenEmbeddingBackfillPass: async () => {},
    startHttpServer: async () => ({
      hostname: "127.0.0.1",
      port: 3000,
      close: async () => {}
    }),
    shutdown: async () => {}
  };

  return {
    ...runtime,
    ...overrides
  };
}

function createRun(overrides: {
  readonly run_id: string;
  readonly workspace_id: string;
}) {
  return {
    run_id: overrides.run_id,
    workspace_id: overrides.workspace_id,
    title: "Run",
    goal: null,
    run_mode: "chat",
    engine_binding_id: null,
    engine_class: "conversation_engine",
    run_state: "idle",
    current_surface_id: null,
    created_at: "2026-04-30T00:00:00.000Z",
    last_active_at: "2026-04-30T00:00:00.000Z"
  } as const;
}

describe("cli registration", () => {

  beforeEach(() => {
    hoisted.runAlayaMcpStdioServer.mockReset();
    hoisted.serverClose.mockReset();
    hoisted.runAlayaMcpStdioServer.mockResolvedValue({
      close: hoisted.serverClose
    });
  });

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
      "update",
      "attach",
      "detach",
      "tools",
      // A1 (HITL daemon backbone) — `alaya review pending|accept|reject`
      // routes through the same MCP handler attached agents use.
      "review",
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

  it("starts Garden background services when the attached MCP stdio transport runs", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const startBackgroundServices = vi.fn();
    const ensureLocalWorkspace = vi.fn(async () => undefined);
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      startBackgroundServices,
      services: {
        ...baseRuntime.services,
        workspaceService: {
          ensureLocalWorkspace
        } as unknown as AlayaDaemonRuntime["services"]["workspaceService"]
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      cwd: "/tmp/alaya-project",
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    hoisted.runAlayaMcpStdioServer.mockImplementationOnce(async () => {
      setImmediate(() => stdin.destroy());
      return { close: hoisted.serverClose };
    });

    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(0);
    expect(ensureLocalWorkspace).toHaveBeenCalledWith({
      workspaceId: expect.stringMatching(/^local_[a-f0-9]{16}$/),
      name: "alaya-project",
      rootPath: "/tmp/alaya-project"
    });
    expect(startBackgroundServices).toHaveBeenCalledTimes(1);
    expect(hoisted.runAlayaMcpStdioServer).toHaveBeenCalledTimes(1);
    const [serverOptions] = hoisted.runAlayaMcpStdioServer.mock.calls[0] ?? [];
    expect(serverOptions).toMatchObject({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      stdin,
      stdout
    });
    const context = serverOptions.contextProvider();
    expect(context).toEqual({
      workspaceId: expect.stringMatching(/^local_[a-f0-9]{16}$/),
      runId: expect.stringMatching(/^mcp-session-[0-9a-f-]+$/),
      agentTarget: "mcp",
      sessionId: expect.stringMatching(/^mcp-session-[0-9a-f-]+$/)
    });
    expect(context.runId).toBe(context.sessionId);
    expect(runtime.services.runService.ensureAttachedMcpSessionRun).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      agentTarget: "mcp"
    });
    expect(hoisted.serverClose).toHaveBeenCalledTimes(1);
  });

  it("passes a workspace-owned ALAYA_RUN_ID into attached MCP tool context", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      services: {
        ...baseRuntime.services,
        runService: {
          ...baseRuntime.services.runService,
          getById: vi.fn(async () => createRun({ run_id: "run-1", workspace_id: "workspace-1" }))
        }
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1",
        ALAYA_RUN_ID: "run-1",
        ALAYA_AGENT_TARGET: "codex"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    hoisted.runAlayaMcpStdioServer.mockImplementationOnce(async () => {
      setImmediate(() => stdin.destroy());
      return { close: hoisted.serverClose };
    });

    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(0);
    expect(runtime.services.runService.getById).toHaveBeenCalledWith("run-1");
    expect(runtime.services.runService.ensureAttachedMcpSessionRun).not.toHaveBeenCalled();
    const [serverOptions] = hoisted.runAlayaMcpStdioServer.mock.calls[0] ?? [];
    expect(serverOptions.contextProvider()).toEqual({
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: expect.stringMatching(/^mcp-session-[0-9a-f-]+$/)
    });
  });

  it("permits garden-worker as an attached MCP agent target", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      services: {
        ...baseRuntime.services,
        runService: {
          ...baseRuntime.services.runService,
          getById: vi.fn(async () => createRun({ run_id: "run-1", workspace_id: "workspace-1" }))
        }
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1",
        ALAYA_RUN_ID: "run-1",
        ALAYA_AGENT_TARGET: "garden-worker"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    hoisted.runAlayaMcpStdioServer.mockImplementationOnce(async () => {
      setImmediate(() => stdin.destroy());
      return { close: hoisted.serverClose };
    });

    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(0);
    const [serverOptions] = hoisted.runAlayaMcpStdioServer.mock.calls[0] ?? [];
    expect(serverOptions.contextProvider()).toEqual({
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "garden-worker",
      sessionId: expect.stringMatching(/^mcp-session-[0-9a-f-]+$/)
    });
  });
});
