import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PhaseCExtensionEventType,
  type EventLogEntry,
  type GardenBacklogSnapshot,
  type HealthJournalRecordInput
} from "@do-what/protocol";
import {
  createDeferred,
  getToolRuntimeWiringFixture,
  resetToolRuntimeWiringState
} from "./tool-runtime-wiring-fixture.js";

const hoisted = getToolRuntimeWiringFixture();

describe("daemon tool runtime bootstrap", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetToolRuntimeWiringState();
  });

  it(
    "awaits runtime-registry close before closing the daemon server on shutdown",
    async () => {
      const stopGate = createDeferred<void>();
      const closeGate = createDeferred<void>();
      const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
      const processOnSpy = vi.spyOn(process, "on");
      processOnSpy.mockImplementation(((event: string, handler: () => void) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          signalHandlers.set(event, handler);
        }
        return process;
      }) as typeof process.on);
      hoisted.backgroundManagerStop.mockImplementationOnce(async () => {
        await stopGate.promise;
      });
      hoisted.mcpRuntimeClose.mockImplementationOnce(async () => {
        await closeGate.promise;
      });

      try {
        await import("../index.js");
        const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];

        expect(backlogTelemetryService).toBeDefined();

        signalHandlers.get("SIGTERM")?.();
        await Promise.resolve();

        expect(hoisted.backgroundManagerStop).toHaveBeenCalledTimes(1);
        expect(hoisted.backgroundManagerStop).toHaveBeenCalledWith({ timeoutMs: null });
        expect(backlogTelemetryService!.stop).not.toHaveBeenCalled();
        expect(hoisted.mcpRuntimeClose).not.toHaveBeenCalled();
        expect(hoisted.serverClose).not.toHaveBeenCalled();

        stopGate.resolve();

        await vi.waitFor(() => {
          expect(backlogTelemetryService!.stop).toHaveBeenCalledTimes(1);
          expect(hoisted.mcpRuntimeClose).toHaveBeenCalledTimes(1);
        });
        expect(hoisted.serverClose).not.toHaveBeenCalled();

        closeGate.resolve();

        await vi.waitFor(() => {
          expect(hoisted.serverClose).toHaveBeenCalledTimes(1);
        });
      } finally {
        processOnSpy.mockRestore();
      }
    },
    10_000
  );

  it(
    "drains background work before stopping backlog telemetry on shutdown",
    async () => {
      const stopGate = createDeferred<void>();
      const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
      const processOnSpy = vi.spyOn(process, "on");
      processOnSpy.mockImplementation(((event: string, handler: () => void) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          signalHandlers.set(event, handler);
        }
        return process;
      }) as typeof process.on);
      hoisted.backgroundManagerStop.mockImplementationOnce(async () => {
        await stopGate.promise;
      });

      try {
        await import("../index.js");

        const backlogTelemetryService = hoisted.gardenBacklogTelemetryServices[0];
        expect(backlogTelemetryService).toBeDefined();

        signalHandlers.get("SIGTERM")?.();
        await Promise.resolve();

        expect(hoisted.backgroundManagerStop).toHaveBeenCalledTimes(1);
        expect(hoisted.backgroundManagerStop).toHaveBeenCalledWith({ timeoutMs: null });
        expect(backlogTelemetryService!.stop).not.toHaveBeenCalled();

        stopGate.resolve();

        await vi.waitFor(() => {
          expect(backlogTelemetryService!.stop).toHaveBeenCalledTimes(1);
        });
      } finally {
        processOnSpy.mockRestore();
      }
    },
    10_000
  );

  it(
    "keeps shutdown open for backlog telemetry captures emitted after the generic stop timeout window",
    async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const [{ BackgroundServiceManager }, coreActual] = await Promise.all([
        vi.importActual<typeof import("../background/bootstrap.js")>("../background/bootstrap.js"),
        vi.importActual<typeof import("@do-what/core")>("@do-what/core")
      ]);
      const { GardenBacklogTelemetryService } = coreActual;
      const warningSnapshot = createSnapshot({
        observed_at: "2026-04-23T08:05:00.000Z",
        queue_depth_total: 12,
        warning_active: true
      });
      let pendingTransition: {
        readonly transition_id: number;
        readonly transition: "arm" | "clear";
        readonly snapshot: GardenBacklogSnapshot;
      } | null = {
        transition_id: 1,
        transition: "arm",
        snapshot: warningSnapshot
      };
      const scheduler = {
        getBacklogSnapshot: vi.fn(() => warningSnapshot),
        peekBacklogWarningTransition: vi.fn(() => pendingTransition),
        peekLastBacklogWarningTransitionId: vi.fn(() => pendingTransition?.transition_id ?? null),
        acknowledgeBacklogWarningTransition: vi.fn((transitionId: number) => {
          if (pendingTransition?.transition_id !== transitionId) {
            return false;
          }

          pendingTransition = null;
          return true;
        })
      };
      const eventLogRepo = {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) =>
          createEventLogEntry(entry)
        ),
        queryByEntity: vi.fn(async () => [])
      };
      const healthJournal = {
        record: vi.fn(async (_entry: HealthJournalRecordInput) => undefined)
      };
      const telemetryService = new GardenBacklogTelemetryService({
        scheduler,
        eventLogRepo,
        healthJournal,
        thresholds: {
          warning_queue_depth: 10,
          warning_rearm_depth: 7,
          snapshot_interval_ms: 1_000
        }
      });
      let backlogTelemetryObserver: { capture(): Promise<void> } | null = telemetryService;
      const requestBacklogTelemetryCapture = (): void => {
        const observer = backlogTelemetryObserver;
        if (observer === null) {
          return;
        }

        void observer.capture().catch(() => undefined);
      };
      const backgroundManager = new BackgroundServiceManager([
        {
          name: "GardenScheduler",
          intervalMs: 100,
          task: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
            requestBacklogTelemetryCapture();
          }
        }
      ]);
      const shutdown = async (): Promise<void> => {
        await backgroundManager.stop({ timeoutMs: null });
        backlogTelemetryObserver = null;
        await telemetryService.stop();
      };

      try {
        backgroundManager.start();
        await vi.advanceTimersByTimeAsync(101);

        let shutdownResolved = false;
        const shutdownPromise = shutdown().then(() => {
          shutdownResolved = true;
        });

        await vi.advanceTimersByTimeAsync(10_001);
        await Promise.resolve();

        expect(shutdownResolved).toBe(false);
        expect(eventLogRepo.append).not.toHaveBeenCalled();
        expect(healthJournal.record).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(4_999);
        await vi.waitFor(() => {
          expect(eventLogRepo.append).toHaveBeenCalledTimes(1);
          expect(healthJournal.record).toHaveBeenCalledTimes(1);
        });

        await expect(shutdownPromise).resolves.toBeUndefined();
        expect(shutdownResolved).toBe(true);
        expect(scheduler.acknowledgeBacklogWarningTransition).toHaveBeenCalledWith(1);
        expect(pendingTransition).toBeNull();
        expect(eventLogRepo.append).toHaveBeenCalledWith(
          expect.objectContaining({
            event_type: PhaseCExtensionEventType.GARDEN_BACKLOG_WARNING
          })
        );
      } finally {
        consoleSpy.mockRestore();
      }
    },
    20_000
  );

  it("enrolls only allowed MCP servers into discovery and the model-visible registry", async () => {
    process.env.DO_WHAT_ALLOWED_MCP_SERVERS = "filesystem";
    process.env.DO_WHAT_MCP_SERVER_CONFIG_JSON = JSON.stringify({
      filesystem: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-filesystem-server.js"]
      },
      github: {
        transport_type: "stdio",
        command: "node",
        args: ["./mock-github-server.js"]
      }
    });
    hoisted.mcpRuntimeServerInfos.push(
      {
        server_name: "filesystem",
        transport_type: "stdio",
        status: "active",
        registered_at: "2026-04-20T12:00:00.000Z"
      },
      {
        server_name: "github",
        transport_type: "stdio",
        status: "active",
        registered_at: "2026-04-20T12:00:01.000Z"
      }
    );
    hoisted.mcpRuntimeServerTools.set("filesystem", [
      {
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);
    hoisted.mcpRuntimeServerTools.set("github", [
      {
        name: "github.search_issues",
        description: "Search issues through GitHub MCP."
      }
    ]);
    hoisted.extensionProviders.push({
      provider_id: "provider.mcp.github",
      name: "GitHub MCP Provider",
      source: "mcp_external",
      tool_specs: [
        {
          tool_id: "mcp__github__search_issues",
          name: "github.search_issues",
          description: "Search issues through GitHub MCP."
        }
      ],
      requires_permission_check: true,
      records_execution: true,
      registered_at: "2026-04-20T11:59:00.000Z"
    });

    await import("../index.js");

    expect(
      (hoisted.mcpDiscoverAndRegister.mock.calls[0]?.[0] as readonly { readonly server_name: string }[]).map(
        (server) => server.server_name
      )
    ).toEqual(["filesystem"]);

    const engine = hoisted.conversationServiceDeps?.engine as
      | { sendMessage(request: unknown): Promise<unknown> }
      | undefined;
    expect(engine).toBeDefined();

    await engine!.sendMessage({});

    expect(
      (hoisted.mcpDiscoverAndRegister.mock.calls.at(-1)?.[0] as readonly { readonly server_name: string }[]).map(
        (server) => server.server_name
      )
    ).toEqual(["filesystem"]);
    expect(hoisted.engineToolSnapshots.at(-1)).toContain("mcp__filesystem__read_file");
    expect(hoisted.engineToolSnapshots.at(-1)).not.toContain("mcp__github__search_issues");
  });

  it("boots ConversationService with the compute-routing resolver and appends routing after stance resolution", async () => {
    await import("../index.js");

    const resolveExecutionStance = hoisted.conversationServiceDeps?.resolveExecutionStance as
      | {
          resolve(params: {
            readonly workspaceId: string;
            readonly runId: string;
            readonly candidates: readonly [];
            readonly modelRef: null;
          }): Promise<unknown>;
        }
      | undefined;

    expect(typeof resolveExecutionStance?.resolve).toBe("function");

    hoisted.eventLogRepo.append.mockClear();
    hoisted.computeRoutingRoute.mockClear();
    hoisted.computeRoutingToModelRef.mockClear();
    hoisted.stanceResolutionResolve.mockClear();

    await resolveExecutionStance?.resolve({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [],
      modelRef: null
    });

    expect(hoisted.computeRoutingRoute).toHaveBeenCalledWith("workspace-1");
    expect(hoisted.eventLogRepo.append).toHaveBeenCalledWith({
      event_type: "compute.provider_routed",
      entity_type: "compute_provider_route",
      entity_id: "decision-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "deterministic_rule",
      revision: 0,
      payload_json: {
        decision_id: "decision-1",
        workspace_id: "workspace-1",
        selected_provider: "stub",
        model_id: "local-heuristics",
        selection_reason: "stub selected as configured fallback compute provider",
        decided_at: "2026-04-12T10:00:00.000Z"
      }
    });
    expect(hoisted.stanceResolutionResolve).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      candidates: [],
      modelRef: {
        provider: "stub",
        model_id: "local-heuristics",
        adapter: "garden.local_heuristics"
      }
    });
    expect(hoisted.stanceResolutionResolve.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.eventLogRepo.append.mock.invocationCallOrder[0]
    );
  });

  it("wires the official_api garden provider through bootstrap and routing without an ad-hoc model env surface", async () => {
    process.env.OPENAI_API_KEY = "sk-official";
    process.env.OFFICIAL_GARDEN_MODEL = "ignored-override";

    await import("../index.js");

    expect(hoisted.officialGardenProviderCtor).toHaveBeenCalledWith({
      apiKey: "sk-official",
      model: "gpt-4.1-mini"
    });
    expect(hoisted.conversationServiceDeps?.gardenComputeProvider).toBe(hoisted.officialGardenProviderInstance);
    expect(hoisted.computeRoutingServiceDeps).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          kind: "official_api",
          provider: hoisted.officialGardenProviderInstance,
          model_id: "gpt-4.1-mini",
          adapter: "garden.official_api"
        })
      ])
    });
  });

  it("syncs write_file and exec_shell conversation tool specs during daemon bootstrap", async () => {
    await import("../index.js");

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.list_directory");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.search_files");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.write_file");
    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.exec_shell");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.write_file" })
    );
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.exec_shell" })
    );
  });

  it("constructs a canonical alias service and injects it into the live claim and tool producers", async () => {
    await import("../index.js");

    expect(hoisted.canonicalAliasServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        aliasMap: {
          "governance_subject.domain": [
            {
              alias: "用户偏好",
              canonical: "user_preference",
              language: "zh",
              domain: "governance_subject.domain"
            }
          ],
          "governance_subject.qualifier.framework": [
            {
              alias: "类型脚本",
              canonical: "typescript",
              language: "zh",
              domain: "governance_subject.qualifier.framework"
            }
          ]
        },
        eventPublisher: expect.any(Object)
      })
    );
    expect(hoisted.claimServiceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalAliasService: expect.any(Object),
        eventPublisher: expect.any(Object)
      })
    );
    expect(hoisted.conversationToolExecutorCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalAliasService: expect.any(Object)
      })
    );
  });

  it("wires the worker-dispatch static alias into the live server hard-constraint allowlist", async () => {
    await import("../index.js");

    const appDeps = hoisted.createApp.mock.calls[0]?.[0] as
      | { listServerHardConstraints?: (workspaceId: string) => Promise<readonly { ref: string; content: string }[]> }
      | undefined;
    expect(typeof appDeps?.listServerHardConstraints).toBe("function");

    const constraints = await appDeps?.listServerHardConstraints?.("workspace-1");

    expect(constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "constraint://worker-dispatch",
          content: "Never mutate files outside approved workspace roots."
        })
      ])
    );
  });

  it("delegates ContextLens assembly directly on the live conversation seam until manifestation candidates exist", async () => {
    await import("../index.js");

    const core = (await import("@do-what/core")) as Record<string, any>;
    const conversationServiceDeps = core.ConversationService.mock.calls[0]?.[0] as
      | {
          readonly contextLensAssembler?: {
            assemble(params: {
              readonly run: {
                readonly run_id: string;
                readonly workspace_id: string;
                readonly run_mode: string;
                readonly title: string;
              };
              readonly surfaceId: string | null;
              readonly displayName?: string;
              readonly runtimeMode: string;
            }): Promise<unknown>;
          };
        }
      | undefined;
    const wrappedAssembler = conversationServiceDeps?.contextLensAssembler;

    expect(core.ManifestationResolver).not.toHaveBeenCalled();
    expect(wrappedAssembler).toBeDefined();

    const order: string[] = [];
    hoisted.contextLensAssemble.mockImplementationOnce(async (params) => {
      order.push("assemble");
      expect(params).toEqual({
        run: {
          run_id: "run-1",
          workspace_id: "workspace-1",
          run_mode: "chat",
          title: "manifestation test"
        },
        surfaceId: "surface://chat/main",
        displayName: "Manifestation pass",
        runtimeMode: "full"
      });
      return {
        contextLens: null,
        workingProjection: {
          entries: [],
          total_token_estimate: 0
        }
      };
    });

    await wrappedAssembler?.assemble({
      run: {
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "manifestation test"
      },
      surfaceId: "surface://chat/main",
      displayName: "Manifestation pass",
      runtimeMode: "full"
    });

    expect(order).toEqual(["assemble"]);
  });

  it("registers missing conversation tool specs when ToolSpecService.findById reports NOT_FOUND", async () => {
    const { CoreError } = await import("@do-what/core");
    hoisted.toolSpecService.findById.mockRejectedValueOnce(new CoreError("NOT_FOUND", "Tool spec not found"));

    await import("../index.js");

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.register).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
  });

  it("updates existing conversation tool specs when ToolSpecService.findById succeeds", async () => {
    hoisted.toolSpecService.findById.mockResolvedValueOnce({
      tool_id: "tools.read_file",
      category: "read",
      description: "Existing spec",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    });

    await import("../index.js");

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
  });

  it("rethrows non-NOT_FOUND errors from conversation tool spec sync without falling through", async () => {
    hoisted.toolSpecService.findById.mockRejectedValueOnce(new Error("storage offline"));

    await expect(import("../index.js")).rejects.toThrow("storage offline");

    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
    expect(hoisted.toolSpecService.update).not.toHaveBeenCalled();
  });

  it("does not fall back to register when update fails after the spec already exists", async () => {
    const { CoreError } = await import("@do-what/core");
    hoisted.toolSpecService.findById.mockResolvedValueOnce({
      tool_id: "tools.read_file",
      category: "read",
      description: "Existing spec",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    });
    hoisted.toolSpecService.update.mockRejectedValueOnce(
      new CoreError("NOT_FOUND", "Tool spec disappeared before update")
    );

    await expect(import("../index.js")).rejects.toThrow("Tool spec disappeared before update");

    expect(hoisted.toolSpecService.findById).toHaveBeenCalledWith("tools.read_file");
    expect(hoisted.toolSpecService.update).toHaveBeenCalledWith(
      expect.objectContaining({ tool_id: "tools.read_file" })
    );
    expect(hoisted.toolSpecService.register).not.toHaveBeenCalled();
  });

  it("marks principal coding unavailable when a required sandbox tool is missing", async () => {
    const appModule = await import("../app.js");

    await import("../index.js");

    expect(hoisted.createEnvironmentStatusService).toHaveBeenCalledWith(
      expect.objectContaining({
        toolNames: ["git", "node", "pnpm", "rg", "claude", "bwrap", "socat"]
      })
    );
    expect(vi.mocked(appModule.createApp)).toHaveBeenCalledWith(
      expect.objectContaining({
        principalCodingEngineAvailable: false
      })
    );
  });
});

function createEventLogEntry(
  entry: Omit<EventLogEntry, "event_id" | "created_at">
): EventLogEntry {
  return {
    ...entry,
    event_id: crypto.randomUUID(),
    created_at: "2026-04-23T08:05:00.000Z"
  };
}

function createSnapshot(
  overrides: Partial<GardenBacklogSnapshot> = {}
): GardenBacklogSnapshot {
  return {
    workspace_id: null,
    observed_at: "2026-04-23T08:00:00.000Z",
    queue_depth_total: 4,
    queue_depth_by_tier: {
      tier_0: 1,
      tier_1: 1,
      tier_2: 2
    },
    in_flight_total: 0,
    warning_active: false,
    ...overrides
  };
}
