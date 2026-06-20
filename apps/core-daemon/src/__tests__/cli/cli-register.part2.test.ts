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

  // Cover the env-spoof guard on the MCP stdio path. ALAYA_AGENT_TARGET
  // values such as cli/inspector must not promote the attached LLM to a
  // human-reviewer surface; the env is sanitised at the boundary.
  it.each([
    { spoof: "cli" as const },
    { spoof: "inspector" as const }
  ])(
    "ignores ALAYA_AGENT_TARGET=$spoof and pins agentTarget to \"mcp\" with a stderr warning",
    async ({ spoof }) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stderrChunks: string[] = [];
      stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
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
          ALAYA_AGENT_TARGET: spoof
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
        agentTarget: "mcp",
        sessionId: expect.stringMatching(/^mcp-session-[0-9a-f-]+$/)
      });
      expect(stderrChunks.join("")).toContain(
        `Ignoring ALAYA_AGENT_TARGET=${spoof}: MCP stdio cannot impersonate human-reviewer surfaces.`
      );
    }
  );

  it("rejects ALAYA_RUN_ID when it belongs to another workspace", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    const startBackgroundServices = vi.fn();
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      startBackgroundServices,
      services: {
        ...baseRuntime.services,
        runService: {
          ...baseRuntime.services.runService,
          getById: vi.fn(async () => createRun({ run_id: "run-foreign", workspace_id: "workspace-2" }))
        }
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1",
        ALAYA_RUN_ID: "run-foreign"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);

    stdin.end();
    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(65);
    expect(stderrChunks.join("")).toContain(
      "ALAYA_RUN_ID run-foreign belongs to workspace workspace-2, not workspace-1."
    );
    expect(startBackgroundServices).not.toHaveBeenCalled();
    expect(hoisted.runAlayaMcpStdioServer).not.toHaveBeenCalled();
  });

  it("rejects ALAYA_RUN_ID when the run is not found", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    const startBackgroundServices = vi.fn();
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      startBackgroundServices,
      services: {
        ...baseRuntime.services,
        runService: {
          ...baseRuntime.services.runService,
          getById: vi.fn(async () => {
            throw new CoreError("NOT_FOUND", "Run not found");
          })
        }
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1",
        ALAYA_RUN_ID: "run-missing"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);

    stdin.end();
    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(65);
    expect(stderrChunks.join("")).toContain(
      "ALAYA_RUN_ID run-missing was not found for workspace workspace-1."
    );
    expect(startBackgroundServices).not.toHaveBeenCalled();
    expect(hoisted.runAlayaMcpStdioServer).not.toHaveBeenCalled();
  });

  it("reports MCP stdio startup failures on stderr without writing JSON-RPC stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    const baseRuntime = createRuntime();
    const runtime = createRuntime({
      services: {
        ...baseRuntime.services,
        runService: {
          ...baseRuntime.services.runService,
          ensureAttachedMcpSessionRun: vi.fn(async () => {
            throw new Error("SQLITE_READONLY: attempt to write a readonly database");
          })
        }
      }
    });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);

    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(70);
    expect(stdoutChunks.join("")).toBe("");
    expect(stderrChunks.join("")).toContain(
      "MCP stdio startup failed: SQLITE_READONLY: attempt to write a readonly database"
    );
    expect(hoisted.runAlayaMcpStdioServer).not.toHaveBeenCalled();
  });

  it("does not start background services when MCP stdio server startup fails", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const startBackgroundServices = vi.fn();
    stdout.on("data", (chunk) => stdoutChunks.push(chunk.toString("utf8")));
    stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
    hoisted.runAlayaMcpStdioServer.mockRejectedValueOnce(new Error("stdio bind failed"));
    const runtime = createRuntime({ startBackgroundServices });
    const bridge = createAlayaCliBridge(runtime, {
      env: {
        ALAYA_WORKSPACE_ID: "workspace-1"
      },
      stdin,
      stdout,
      stderr,
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);

    const result = await bridge.dispatch(["mcp", "stdio"]);

    expect(result.exitCode).toBe(70);
    expect(stdoutChunks.join("")).toBe("");
    expect(stderrChunks.join("")).toContain("MCP stdio startup failed: stdio bind failed");
    expect(startBackgroundServices).not.toHaveBeenCalled();
    expect(hoisted.serverClose).not.toHaveBeenCalled();
  });
});
